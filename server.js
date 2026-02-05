require('dotenv').config();
const express = require('express');
const cors = require('cors'); // Ajout indispensable
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Autorise ton front-end à contacter ton back-end
app.use(cors());
app.use(express.json());

const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Petite route de test pour voir si le serveur répond
app.get('/', (req, res) => {
    res.send('✅ TrainNomad Backend est en ligne !');
});

app.get('/api/billets', async (req, res) => {
    const { depart, arrivee, date } = req.query;

    let query = supabase
        .from('trajets')
        .select('*')
        .ilike('gare_depart', `%${depart}%`) // Recherche flexible (ex: "Angers" trouvera "Angers St-Laud")
        .ilike('gare_arrivee', `%${arrivee}%`);

    // Si tu fournis une date, on filtre aussi par date
    if (date) {
        query = query.eq('date_trajet', date);
    }

    const { data, error } = await query.order('heure_depart', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur prêt : http://localhost:${PORT}`);
});