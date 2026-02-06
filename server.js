require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialisation Supabase
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_KEY
);

// Route de test
app.get('/', (req, res) => {
    res.json({
        message: '✅ TrainNomad Backend connecté à Supabase !',
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// Route de santé
app.get('/health', async (req, res) => {
    try {
        // Test de connexion à Supabase
        const { count, error } = await supabase
            .from('trajets')
            .select('*', { count: 'exact', head: true });
        
        if (error) throw error;
        
        res.json({ 
            status: 'healthy',
            database: 'connected',
            trajets_count: count
        });
    } catch (error) {
        res.status(500).json({ 
            status: 'unhealthy',
            database: 'error',
            error: error.message
        });
    }
});

// Route pour récupérer tous les trajets
app.get('/api/trajets', async (req, res) => {
    try {
        const { data, error, count } = await supabase
            .from('trajets')
            .select('*', { count: 'exact' })
            .order('heure_depart', { ascending: true });

        if (error) throw error;

        res.json({
            success: true,
            count: count,
            data: data
        });
    } catch (error) {
        console.error('Erreur récupération trajets:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route pour rechercher des billets
app.get('/api/billets', async (req, res) => {
    try {
        const { depart, arrivee, date } = req.query;

        if (!depart || !arrivee) {
            return res.status(400).json({
                success: false,
                error: 'Les paramètres "depart" et "arrivee" sont requis'
            });
        }

        // Construction de la requête
        let query = supabase
            .from('trajets')
            .select('*')
            .ilike('gare_depart', `%${depart}%`)
            .ilike('gare_arrivee', `%${arrivee}%`);

        // Filtre par date si fourni
        if (date) {
            query = query.eq('date_trajet', date);
        }

        const { data, error, count } = await query
            .order('heure_depart', { ascending: true });

        if (error) throw error;

        res.json({
            success: true,
            count: data.length,
            query: { depart, arrivee, date },
            data: data
        });
    } catch (error) {
        console.error('Erreur recherche billets:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route pour récupérer un trajet spécifique
app.get('/api/trajets/:id', async (req, res) => {
    try {
        const id = parseInt(req.params.id);

        if (isNaN(id)) {
            return res.status(400).json({
                success: false,
                error: 'ID invalide'
            });
        }

        const { data, error } = await supabase
            .from('trajets')
            .select('*')
            .eq('id', id)
            .single();

        if (error) {
            if (error.code === 'PGRST116') {
                return res.status(404).json({
                    success: false,
                    error: 'Trajet non trouvé'
                });
            }
            throw error;
        }

        res.json({
            success: true,
            data: data
        });
    } catch (error) {
        console.error('Erreur récupération trajet:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route pour récupérer les gares disponibles (utile pour l'autocomplete)
app.get('/api/gares', async (req, res) => {
    try {
        // Récupérer toutes les gares uniques
        const { data: departures, error: error1 } = await supabase
            .from('trajets')
            .select('gare_depart');

        const { data: arrivals, error: error2 } = await supabase
            .from('trajets')
            .select('gare_arrivee');

        if (error1 || error2) throw error1 || error2;

        // Créer un Set pour éviter les doublons
        const gares = new Set();
        departures.forEach(row => gares.add(row.gare_depart));
        arrivals.forEach(row => gares.add(row.gare_arrivee));

        res.json({
            success: true,
            count: gares.size,
            data: Array.from(gares).sort()
        });
    } catch (error) {
        console.error('Erreur récupération gares:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée',
        availableRoutes: [
            'GET /',
            'GET /health',
            'GET /api/trajets',
            'GET /api/billets?depart=XXX&arrivee=YYY&date=YYYY-MM-DD',
            'GET /api/trajets/:id',
            'GET /api/gares'
        ]
    });
});

// Gestion des erreurs serveur
app.use((err, req, res, next) => {
    console.error('Erreur serveur:', err);
    res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📍 URL locale: http://localhost:${PORT}`);
    console.log(`🗄️  Connecté à Supabase`);
    console.log(`✅ Prêt à recevoir des requêtes !`);
});