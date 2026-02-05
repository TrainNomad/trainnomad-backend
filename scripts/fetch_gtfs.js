require('dotenv').config();
const axios = require('axios');
const { createClient } = require('@supabase/supabase-js');

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

async function importSNCFData() {
    console.log("📥 Récupération des données Open Data SNCF...");
    
    try {
        // On interroge l'API pour les trajets Angers -> Nantes
        const url = "https://ressources.data.sncf.com/api/explore/v2.1/catalog/datasets/horaires-sncf/records?where=gare_depart=\"Angers St-Laud\" AND gare_arrivee=\"Nantes\"&limit=50";
        
        const response = await axios.get(url);
        const records = response.data.results;

        const formattedData = records.map(r => ({
            gare_depart: r.gare_depart,
            gare_arrivee: r.gare_arrivee,
            heure_depart: r.heure_depart,
            heure_arrivee: r.heure_arrivee,
            type_train: r.type_transport
        }));

        const { error } = await supabase
            .from('trajets')
            .upsert(formattedData); // upsert évite les doublons

        if (error) throw error;
        console.log("✅ Données importées dans Supabase !");
    } catch (err) {
        console.error("❌ Erreur d'import :", err.message);
    }
}

importSNCFData();