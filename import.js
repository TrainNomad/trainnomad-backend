require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const csv = require('csv-parser');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);
const DATA_PATH = './'; // Dossier où se trouvent tes fichiers

// --- UTILITAIRES DE CLASSIFICATION ---
function getTrainType(row) {
    const trainNumber = row.trip_headsign || row.trip_short_name || "";
    const num = parseInt(trainNumber, 10);
    const routeId = (row.route_id || "").toLowerCase();

    if ((num >= 7600 && num <= 7999) || routeId.includes('ouigo')) return 'ouigo_gv';
    if (num >= 4000 && num <= 4699) return 'ouigo_classique';
    if ((num >= 3000 && num <= 5999) || routeId.includes('intercites')) return 'intercites';
    if (String(trainNumber).trim().length === 4 || routeId.includes('tgv')) return 'tgv_inoui';
    return 'ter';
}

function extractUIC(stopId) {
    const match = stopId.match(/(\d{8})/);
    return match ? match[1] : null;
}

// --- FONCTION D'IMPORTATION GÉNÉRALE (CSV & JSON) ---
async function importTable(tableName, fileName, isJson = false) {
    const fullPath = DATA_PATH + fileName;
    if (!fs.existsSync(fullPath)) return { skipped: true };

    console.log(`⏳ Traitement de ${tableName}...`);
    let dataToInsert = [];

    if (isJson) {
        const raw = JSON.parse(fs.readFileSync(fullPath, 'utf8'));
        dataToInsert = raw.map(row => ({
            transporteur: row.transporteur,
            train_type: row.transporteur === 'OUIGO' ? (row.prix_minimum < 15 ? 'ouigo_classique' : 'ouigo_gv') : 
                        row.transporteur === 'TGV INOUI' ? 'tgv_inoui' : 'intercites',
            uic_depart: row.gare_origine_code_uic,
            uic_arrivee: row.gare_destination_code_uic,
            profil_tarifaire: row.profil_tarifaire,
            prix_minimum: row.prix_minimum,
            prix_maximum: row.prix_maximum
        }));
    } else {
        // Lecture CSV avec gestion du BOM UTF-8 pour éviter les erreurs de colonnes
        dataToInsert = await new Promise((resolve) => {
            const results = [];
            fs.createReadStream(fullPath)
                .pipe(csv({ mapHeaders: ({ header }) => header.trim().replace(/^\uFEFF/, '') }))
                .on('data', (row) => {
                    // Transformations spécifiques selon la table
                    if (tableName === 'trips') {
                        row.train_type = getTrainType(row);
                    } else if (tableName === 'stops') {
                        row.uic_code = extractUIC(row.stop_id);
                    }
                    results.push(row);
                })
                .on('end', () => resolve(results));
        });
    }

    // Insertion par paquets avec UPSERT pour éviter les erreurs de répétition
    let total = 0;
    for (let i = 0; i < dataToInsert.length; i += 500) {
        const batch = dataToInsert.slice(i, i + 500);
        const { error } = await supabase.from(tableName).upsert(batch, { onConflict: getConflictKey(tableName) });
        if (error) {
            console.error(`❌ Erreur ${tableName}:`, error.message);
        } else {
            total += batch.length;
        }
    }
    return { count: total };
}

function getConflictKey(table) {
    const keys = { 'stops': 'stop_id', 'trips': 'trip_id', 'routes': 'route_id', 'calendar_dates': null };
    return keys[table];
}

// --- LANCEMENT GLOBAL ---
async function run() {
    const startTime = Date.now();
    
    // On définit l'ordre et les types
    const tables = [
        { name: 'stops', file: 'stops.txt' },
        { name: 'trips', file: 'trips.txt' },
        { name: 'calendar_dates', file: 'calendar_dates.txt' },
        { name: 'tarifs_tgv', file: 'tarifs-tgv-inoui-ouigo.json', json: true }
    ];

    for (const t of tables) {
        const res = await importTable(t.name, t.file, t.json);
        console.log(`✅ ${t.name.padEnd(15)} : ${res.count || 0} enregistrements traités`);
    }

    console.log(`\n🏁 Terminé en ${((Date.now() - startTime) / 1000).toFixed(2)}s`);
}

run();