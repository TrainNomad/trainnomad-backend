require('dotenv').config();
const fs = require('fs');
const { createClient } = require('@supabase/supabase-js');
const csv = require('csv-parser');

// Initialisation Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

async function importStops() {
    console.log("📥 Début de l'import des stops...");
    
    const stops = [];
    
    // Lire le fichier CSV
    fs.createReadStream('stops.txt')
        .pipe(csv())
        .on('data', (row) => {
            // Transformer chaque ligne en objet
            const stop = {
                stop_id: row.stop_id || null,
                stop_name: row.stop_name || null,
                stop_desc: row.stop_desc || null,
                stop_lat: row.stop_lat ? parseFloat(row.stop_lat) : null,
                stop_lon: row.stop_lon ? parseFloat(row.stop_lon) : null,
                zone_id: row.zone_id || null,
                stop_url: row.stop_url || null,
                location_type: row.location_type ? parseInt(row.location_type) : null,
                parent_station: row.parent_station || null
            };
            
            stops.push(stop);
        })
        .on('end', async () => {
            console.log(`📊 ${stops.length} stops à importer`);
            
            try {
                // Importer par batch de 1000 pour éviter les timeouts
                const batchSize = 1000;
                for (let i = 0; i < stops.length; i += batchSize) {
                    const batch = stops.slice(i, i + batchSize);
                    
                    const { data, error } = await supabase
                        .from('stops')
                        .upsert(batch, { 
                            onConflict: 'stop_id',
                            ignoreDuplicates: false 
                        });
                    
                    if (error) {
                        console.error(`❌ Erreur batch ${i / batchSize + 1}:`, error.message);
                        throw error;
                    }
                    
                    console.log(`✅ Batch ${i / batchSize + 1} importé (${batch.length} stops)`);
                }
                
                console.log("🎉 Import terminé avec succès !");
                
            } catch (err) {
                console.error("❌ Erreur lors de l'import:", err.message);
                process.exit(1);
            }
        })
        .on('error', (error) => {
            console.error("❌ Erreur de lecture du fichier:", error.message);
            process.exit(1);
        });
}

// Lancer l'import
importStops();