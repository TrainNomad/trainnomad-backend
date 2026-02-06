require('dotenv').config();
const express = require('express');
const cors = require('cors');

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Route de test
app.get('/', (req, res) => {
    res.json({
        message: '✅ TrainNomad Backend est en ligne !',
        status: 'OK',
        timestamp: new Date().toISOString()
    });
});

// Route de santé pour Render
app.get('/health', (req, res) => {
    res.json({ status: 'healthy' });
});

// Données de test en dur (pour commencer)
const trajetsTest = [
    {
        id: 1,
        gare_depart: 'Angers St-Laud',
        gare_arrivee: 'Nantes',
        heure_depart: '08:15',
        heure_arrivee: '09:00',
        type_train: 'TER',
        prix: 15.50
    },
    {
        id: 2,
        gare_depart: 'Angers St-Laud',
        gare_arrivee: 'Nantes',
        heure_depart: '10:30',
        heure_arrivee: '11:15',
        type_train: 'TER',
        prix: 15.50
    },
    {
        id: 3,
        gare_depart: 'Angers St-Laud',
        gare_arrivee: 'Nantes',
        heure_depart: '14:45',
        heure_arrivee: '15:30',
        type_train: 'TGV',
        prix: 25.00
    },
    {
        id: 4,
        gare_depart: 'Paris Montparnasse',
        gare_arrivee: 'Nantes',
        heure_depart: '09:00',
        heure_arrivee: '11:15',
        type_train: 'TGV',
        prix: 45.00
    },
    {
        id: 5,
        gare_depart: 'Paris Montparnasse',
        gare_arrivee: 'Angers St-Laud',
        heure_depart: '10:30',
        heure_arrivee: '12:00',
        type_train: 'TGV',
        prix: 38.00
    }
];

// Route pour récupérer tous les trajets
app.get('/api/trajets', (req, res) => {
    res.json({
        success: true,
        count: trajetsTest.length,
        data: trajetsTest
    });
});

// Route pour rechercher des billets
app.get('/api/billets', (req, res) => {
    const { depart, arrivee, date } = req.query;

    if (!depart || !arrivee) {
        return res.status(400).json({
            success: false,
            error: 'Les paramètres "depart" et "arrivee" sont requis'
        });
    }

    // Filtrer les trajets
    const results = trajetsTest.filter(trajet => {
        const matchDepart = trajet.gare_depart.toLowerCase().includes(depart.toLowerCase());
        const matchArrivee = trajet.gare_arrivee.toLowerCase().includes(arrivee.toLowerCase());
        return matchDepart && matchArrivee;
    });

    res.json({
        success: true,
        count: results.length,
        query: { depart, arrivee, date },
        data: results
    });
});

// Route pour récupérer un trajet spécifique
app.get('/api/trajets/:id', (req, res) => {
    const id = parseInt(req.params.id);
    const trajet = trajetsTest.find(t => t.id === id);

    if (!trajet) {
        return res.status(404).json({
            success: false,
            error: 'Trajet non trouvé'
        });
    }

    res.json({
        success: true,
        data: trajet
    });
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
            'GET /api/billets?depart=XXX&arrivee=YYY',
            'GET /api/trajets/:id'
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
    console.log(`✅ Prêt à recevoir des requêtes !`);
});
