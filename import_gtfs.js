require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const csv = require('csv-parser');

// Initialisation Supabase
// IMPORTANT: Utilisez SUPABASE_SERVICE_KEY pour l'import (pas SUPABASE_KEY)
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_KEY || process.env.SUPABASE_KEY
);

// Configuration des tables GTFS
const GTFS_TABLES = {
    stops: {
        file: 'stops.txt',
        uniqueKey: 'stop_id',
        transform: (row) => ({
            stop_id: row.stop_id || null,
            stop_name: row.stop_name || null,
            stop_desc: row.stop_desc || null,
            stop_lat: row.stop_lat ? parseFloat(row.stop_lat) : null,
            stop_lon: row.stop_lon ? parseFloat(row.stop_lon) : null,
            zone_id: row.zone_id || null,
            stop_url: row.stop_url || null,
            location_type: row.location_type ? parseInt(row.location_type) : null,
            parent_station: row.parent_station || null
        })
    },
    routes: {
        file: 'routes.txt',
        uniqueKey: 'route_id',
        transform: (row) => ({
            route_id: row.route_id || null,
            agency_id: row.agency_id || null,
            route_short_name: row.route_short_name || null,
            route_long_name: row.route_long_name || null,
            route_desc: row.route_desc || null,
            route_type: row.route_type ? parseInt(row.route_type) : null,
            route_url: row.route_url || null,
            route_color: row.route_color || null,
            route_text_color: row.route_text_color || null
        })
    },
    trips: {
        file: 'trips.txt',
        uniqueKey: 'trip_id',
        transform: (row) => {
            const trainNumber = parseInt(row.trip_headsign || "", 10);
            const routeId = row.route_id || "";
            
            // TA LOGIQUE DE DÉTERMINATION DU TYPE
            let type = 'ter'; // Par défaut

            if (routeId.includes('OUIGO') || (trainNumber >= 7600 && trainNumber <= 7999)) {
                type = 'ouigo_gv';
            } else if (trainNumber >= 4000 && trainNumber <= 4699) {
                type = 'ouigo_classique';
            } else if (routeId.includes('INTERCITES') || (trainNumber >= 3000 && trainNumber <= 5999)) {
                type = 'intercites';
            } else if (routeId.includes('TGV') || String(trainNumber).length === 4) {
                type = 'tgv_inoui';
            }

            return {
                trip_id: row.trip_id,
                route_id: row.route_id,
                service_id: row.service_id,
                trip_headsign: row.trip_headsign,
                train_number: row.trip_headsign,
                train_type: type // C'est ici que la colonne se génère !
            };
        }
    },
    calendar_dates: {
        file: 'calendar_dates.txt',
        uniqueKey: null, // Pas de clé unique simple (combinaison service_id + date)
        transform: (row) => ({
            service_id: row.service_id || null,
            date: row.date ? formatDate(row.date) : null,
            exception_type: row.exception_type ? parseInt(row.exception_type) : null
        })
    },
    stop_times: {
        file: 'stop_times.txt',
        uniqueKey: null, // Pas de clé unique (combinaison trip_id + stop_sequence)
        transform: (row) => ({
            trip_id: row.trip_id || null,
            arrival_time: row.arrival_time || null,
            departure_time: row.departure_time || null,
            stop_id: row.stop_id || null,
            stop_sequence: row.stop_sequence ? parseInt(row.stop_sequence) : null,
            stop_headsign: row.stop_headsign || null,
            pickup_type: row.pickup_type ? parseInt(row.pickup_type) : null,
            drop_off_type: row.drop_off_type ? parseInt(row.drop_off_type) : null,
            shape_dist_traveled: row.shape_dist_traveled ? parseFloat(row.shape_dist_traveled) : null
        })
    },
    tarifs_tgv: {
        file: 'tarifs-tgv-inoui-ouigo.json',
        uniqueKey: 'id',
        transform: (row) => {
            // Mapping pour que le nom du JSON corresponde au type du trajet
            let type = 'ter';
            if (row.transporteur === 'OUIGO') {
                // On peut affiner ici si le JSON précise "Classique"
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
                prix_min: row.prix_minimum,
                prix_max: row.prix_maximum
            };
        }
    }
};

// Fonction utilitaire pour le mapping des tarifs
function mapCommercialToType(transporteur, prix) {
    if (transporteur === 'OUIGO') {
        // Si le prix mini est très bas, c'est souvent du classique, 
        // mais l'idéal est de se baser sur le transporteur exact du JSON
        return prix < 15 ? 'ouigo_classique' : 'ouigo_gv';
    }
    if (transporteur === 'TGV INOUI') return 'tgv_inoui';
    if (transporteur === 'INTERCITES') return 'intercites';
    return 'ter';
}

// Fonction pour formater les dates YYYYMMDD vers YYYY-MM-DD
function formatDate(dateStr) {
    if (!dateStr || dateStr.length !== 8) return null;
    const year = dateStr.substring(0, 4);
    const month = dateStr.substring(4, 6);
    const day = dateStr.substring(6, 8);
    return `${year}-${month}-${day}`;
}

// Fonction pour importer une table
async function importTable(tableName, config) {
    return new Promise((resolve, reject) => {
        console.log(`\n📥 Import de ${tableName} depuis ${config.file}...`);
        
        // Vérifier si le fichier existe
        if (!fs.existsSync(config.file)) {
            console.log(`⏭️  Fichier ${config.file} non trouvé, passage à la table suivante.`);
            resolve({ skipped: true });
            return;
        }

        const records = [];
        
        fs.createReadStream(config.file)
            .pipe(csv())
            .on('data', (row) => {
                try {
                    const transformedRow = config.transform(row);
                    records.push(transformedRow);
                } catch (error) {
                    console.error(`❌ Erreur transformation ligne:`, error.message);
                }
            })
            .on('end', async () => {
                if (records.length === 0) {
                    console.log(`⚠️  Aucune donnée à importer pour ${tableName}`);
                    resolve({ count: 0 });
                    return;
                }

                console.log(`📊 ${records.length} enregistrements à importer dans ${tableName}`);
                
                try {
                    // Import par batch de 1000
                    const batchSize = 1000;
                    let totalImported = 0;
                    
                    for (let i = 0; i < records.length; i += batchSize) {
                        const batch = records.slice(i, i + batchSize);
                        
                        const { data, error } = await supabase
                            .from(tableName)
                            .upsert(batch, { 
                                onConflict: config.uniqueKey || undefined,
                                ignoreDuplicates: false 
                            });
                        
                        if (error) {
                            console.error(`❌ Erreur batch ${Math.floor(i / batchSize) + 1}:`, error.message);
                            // On continue malgré l'erreur
                        } else {
                            totalImported += batch.length;
                            console.log(`✅ Batch ${Math.floor(i / batchSize) + 1}/${Math.ceil(records.length / batchSize)} importé (${batch.length} enregistrements)`);
                        }
                    }
                    
                    console.log(`🎉 ${tableName} : ${totalImported} enregistrements importés avec succès !`);
                    resolve({ count: totalImported });
                    
                } catch (err) {
                    console.error(`❌ Erreur lors de l'import de ${tableName}:`, err.message);
                    reject(err);
                }
            })
            .on('error', (error) => {
                console.error(`❌ Erreur de lecture du fichier ${config.file}:`, error.message);
                reject(error);
            });
    });
}

// Fonction principale
async function importAllGTFS() {
    console.log("=".repeat(60));
    console.log("🚀 IMPORT GTFS COMPLET VERS SUPABASE");
    console.log("=".repeat(60));
    
    const startTime = Date.now();
    const results = {};
    
    // Ordre d'import (important pour les dépendances)
    const importOrder = ['stops', 'routes', 'calendar_dates', 'trips', 'stop_times'];
    
    for (const tableName of importOrder) {
        try {
            const result = await importTable(tableName, GTFS_TABLES[tableName]);
            results[tableName] = result;
        } catch (error) {
            console.error(`❌ Échec de l'import de ${tableName}, on continue...`);
            results[tableName] = { error: error.message };
        }
    }
    
    // Résumé final
    const endTime = Date.now();
    const duration = ((endTime - startTime) / 1000).toFixed(2);
    
    console.log("\n" + "=".repeat(60));
    console.log("📊 RÉSUMÉ DE L'IMPORT");
    console.log("=".repeat(60));
    
    for (const [table, result] of Object.entries(results)) {
        if (result.skipped) {
            console.log(`⏭️  ${table.padEnd(20)} : Fichier non trouvé`);
        } else if (result.error) {
            console.log(`❌ ${table.padEnd(20)} : Erreur - ${result.error}`);
        } else {
            console.log(`✅ ${table.padEnd(20)} : ${result.count} enregistrements`);
        }
    }
    
    console.log("=".repeat(60));
    console.log(`⏱️  Durée totale : ${duration} secondes`);
    console.log("🎉 Import terminé !");
    console.log("=".repeat(60));
}

// Lancer l'import
importAllGTFS().catch(error => {
    console.error("💥 Erreur fatale:", error);
    process.exit(1);
});