require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const csv = require('csv-parser');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_KEY);

const DATA_PATH = './'; // Modifie si tes fichiers sont dans un sous-dossier comme './data/'

// --- LOGIQUE DE CLASSIFICATION ---
function getTrainType(row) {
    // On essaie de trouver le numéro de train peu importe le nom de la colonne (headsign ou trip_short_name)
    const trainNumber = row.trip_headsign || row.trip_short_name || "";
    const num = parseInt(trainNumber, 10);
    const routeId = (row.route_id || "").toLowerCase();

    if ((num >= 7600 && num <= 7999) || routeId.includes('ouigo')) return 'ouigo_gv';
    if (num >= 4000 && num <= 4699) return 'ouigo_classique';
    if ((num >= 3000 && num <= 5999) || routeId.includes('intercites')) return 'intercites';
    if (String(trainNumber).trim().length === 4 || routeId.includes('tgv')) return 'tgv_inoui';
    return 'ter';
}

// --- FONCTION D'IMPORT CSV GÉNÉRIQUE ---
async function importCSV(tableName, fileName, transformFn) {
    return new Promise((resolve) => {
        const results = [];
        const fullPath = DATA_PATH + fileName;

        if (!fs.existsSync(fullPath)) {
            console.log(`⏭️  Fichier ${fileName} introuvable.`);
            return resolve(0);
        }

        fs.createReadStream(fullPath)
            .pipe(csv({
                mapHeaders: ({ header }) => header.trim().replace(/^\uFEFF/, '') // Supprime le BOM UTF-8
            }))
            .on('data', (data) => {
                const transformed = transformFn(data);
                if (transformed) results.push(transformed);
            })
            .on('end', async () => {
                if (results.length === 0) return resolve(0);
                
                console.log(`📦 Envoi de ${results.length} lignes vers ${tableName}...`);
                for (let i = 0; i < results.length; i += 500) {
                    const batch = results.slice(i, i + 500);
                    const { error } = await supabase.from(tableName).upsert(batch);
                    if (error) console.error(`❌ Erreur sur ${tableName} (batch ${i}):`, error.message);
                }
                resolve(results.length);
            });
    });
}

// --- FONCTION D'IMPORT JSON (TARIFS) ---
async function importTarifsJSON() {
    const fileName = 'tarifs-tgv-inoui-ouigo.json';
    const fullPath = DATA_PATH + fileName;

    if (!fs.existsSync(fullPath)) {
        console.log("⏭️ Fichier tarifs JSON introuvable.");
        return 0;
    }

    const raw = fs.readFileSync(fullPath, 'utf8');
    const data = JSON.parse(raw);

    const transformed = data.map(row => {
        let type = 'ter';
        if (row.transporteur === 'OUIGO') {
            type = row.prix_minimum < 15 ? 'ouigo_classique' : 'ouigo_gv';
        } else if (row.transporteur === 'TGV INOUI') {
            type = 'tgv_inoui';
        } else if (row.transporteur === 'INTERCITES') {
            type = 'intercites';
        }

        return {
            transporteur: row.transporteur,
            train_type: type,
            uic_depart: row.gare_origine_code_uic,
            uic_arrivee: row.gare_destination_code_uic,
            profil_tarifaire: row.profil_tarifaire,
            prix_minimum: row.prix_minimum, // Changé ici
            prix_maximum: row.prix_maximum  // Changé ici
        };
    });

    // On insère par paquets car le JSON peut être gros
    for (let i = 0; i < transformed.length; i += 500) {
        const batch = transformed.slice(i, i + 500);
        const { error } = await supabase.from('tarifs_tgv').insert(batch);
        if (error) {
            console.error("❌ Erreur Tarifs JSON:", error.message);
            return 0;
        }
    }
    return transformed.length;
}

// --- LANCEMENT ---
async function run() {
    console.log("🚀 Démarrage de l'importation corrective...");

    const tripsCount = await importCSV('trips', 'trips.txt', (row) => ({
        trip_id: row.trip_id,
        route_id: row.route_id,
        service_id: row.service_id,
        trip_headsign: row.trip_headsign || row.trip_short_name,
        train_type: getTrainType(row)
    }));
    console.log(`✅ Trips : ${tripsCount} enregistrements`);

    const calCount = await importCSV('calendar_dates', 'calendar_dates.txt', (row) => ({
        service_id: row.service_id,
        date: row.date,
        exception_type: parseInt(row.exception_type)
    }));
    console.log(`✅ Calendar Dates : ${calCount} enregistrements`);

    const tarifsCount = await importTarifsJSON();
    console.log(`✅ Tarifs TGV : ${tarifsCount} enregistrements`);
}

run();