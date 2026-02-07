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
        message: '✅ TrainNomad Backend GTFS connecté à Supabase !',
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '3.0 - GTFS Fixed'
    });
});

// Route de santé avec debug
app.get('/health', async (req, res) => {
    try {
        const checks = {
            stops: null,
            routes: null,
            trips: null,
            stop_times: null,
            calendar_dates: null
        };

        // Test chaque table individuellement
        try {
            const { count } = await supabase.from('stops').select('*', { count: 'exact', head: true });
            checks.stops = count;
        } catch (e) {
            checks.stops = `Error: ${e.message}`;
        }

        try {
            const { count } = await supabase.from('routes').select('*', { count: 'exact', head: true });
            checks.routes = count;
        } catch (e) {
            checks.routes = `Error: ${e.message}`;
        }

        try {
            const { count } = await supabase.from('trips').select('*', { count: 'exact', head: true });
            checks.trips = count;
        } catch (e) {
            checks.trips = `Error: ${e.message}`;
        }

        try {
            const { count } = await supabase.from('stop_times').select('*', { count: 'exact', head: true });
            checks.stop_times = count;
        } catch (e) {
            checks.stop_times = `Error: ${e.message}`;
        }

        try {
            const { count } = await supabase.from('calendar_dates').select('*', { count: 'exact', head: true });
            checks.calendar_dates = count;
        } catch (e) {
            checks.calendar_dates = `Error: ${e.message}`;
        }

        res.json({
            status: 'healthy',
            database: 'connected',
            tables: checks
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            database: 'error',
            error: error.message
        });
    }
});

// ===================================
// ROUTE PRINCIPALE DE RECHERCHE
// ===================================
app.get('/api/trains', async (req, res) => {
    try {
        const { from, to, date } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ error: "Paramètres manquants" });
        }

        console.log(`🔍 Recherche optimisée : ${from} -> ${to} le ${date}`);

        // 1. Trouver les IDs des gares (Départ et Arrivée)
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const departStopIds = stops.filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase())).map(s => s.stop_id);
        const arriveeStopIds = stops.filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase())).map(s => s.stop_id);

        if (departStopIds.length === 0 || arriveeStopIds.length === 0) {
            return res.json({ success: true, count: 0, message: "Gares non trouvées" });
        }

        // 2. LA REQUÊTE MAGIQUE : Une seule requête pour tout lier
        // On part de stop_times, on lie les trips, les routes et on vérifie le calendrier
        const { data: results, error } = await supabase
            .from('stop_times')
            .select(`
                trip_id,
                arrival_time,
                departure_time,
                stop_sequence,
                stop_id,
                stops (stop_name),
                trips!inner (
                    trip_headsign,
                    route_id,
                    routes (route_short_name, route_long_name),
                    calendar_dates!inner (date, exception_type)
                )
            `)
            .in('stop_id', [...departStopIds, ...arriveeStopIds])
            .eq('trips.calendar_dates.date', date) // Utilise bien le format YYYY-MM-DD de votre image
            .eq('trips.calendar_dates.exception_type', 1);

        if (error) throw error;

        // 3. Réorganiser les données pour coupler les départs et arrivées
        const tripsMap = {};
        results.forEach(row => {
            if (!tripsMap[row.trip_id]) {
                tripsMap[row.trip_id] = { departure: null, arrival: null };
            }
            
            if (departStopIds.includes(row.stop_id)) {
                tripsMap[row.trip_id].departure = row;
            } else if (arriveeStopIds.includes(row.stop_id)) {
                tripsMap[row.trip_id].arrival = row;
            }
        });

        // 4. Filtrer les trajets valides (Départ avant Arrivée) et formater
        const finalTrains = Object.values(tripsMap)
            .filter(t => t.departure && t.arrival && t.departure.stop_sequence < t.arrival.stop_sequence)
            .map(t => ({
                trip_id: t.departure.trip_id,
                train_number: t.departure.trips.routes.route_short_name || 'N/A',
                train_type: t.departure.trips.routes.route_long_name || t.departure.trips.trip_headsign,
                depart_station: t.departure.stops.stop_name,
                arrival_station: t.arrival.stops.stop_name,
                depart_time: t.departure.departure_time,
                arrival_time: t.arrival.arrival_time,
                duration: calculateDuration(t.departure.departure_time, t.arrival.arrival_time)
            }))
            .sort((a, b) => a.depart_time.localeCompare(b.depart_time));

        res.json({
            success: true,
            count: finalTrains.length,
            date: date,
            trains: finalTrains
        });

    } catch (error) {
        console.error('💥 Erreur:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// Route pour voir les dates disponibles
app.get('/api/available-dates', async (req, res) => {
    try {
        // Récupérer toutes les dates uniques
        const { data: dates, error } = await supabase
            .from('calendar_dates')
            .select('date')
            .eq('exception_type', 1)
            .order('date', { ascending: true });

        if (error) throw error;

        // Extraire les dates uniques
        const uniqueDates = [...new Set(dates.map(d => d.date))];

        // Trouver min et max
        const minDate = uniqueDates[0];
        const maxDate = uniqueDates[uniqueDates.length - 1];

        // Grouper par mois
        const byMonth = {};
        uniqueDates.forEach(date => {
            const month = date.substring(0, 7); // YYYY-MM
            if (!byMonth[month]) byMonth[month] = [];
            byMonth[month].push(date);
        });

        res.json({
            success: true,
            dateRange: {
                first: minDate,
                last: maxDate,
                totalDays: uniqueDates.length
            },
            byMonth: byMonth,
            sampleDates: uniqueDates.slice(0, 10),
            message: `Données disponibles du ${minDate} au ${maxDate}`
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Route de debug pour vérifier les dates
app.get('/api/debug/dates', async (req, res) => {
    try {
        const { date } = req.query;

        // 1. Voir quelques exemples de dates
        const { data: sampleDates } = await supabase
            .from('calendar_dates')
            .select('date, exception_type, service_id')
            .limit(10);

        // 2. Si une date est fournie, chercher autour
        let searchResults = null;
        if (date) {
            const searchDate = date.replace(/-/g, '');
            const { data } = await supabase
                .from('calendar_dates')
                .select('date, exception_type, service_id')
                .ilike('date', `%${searchDate}%`);
            searchResults = data;
        }

        // 3. Compter par type d'exception
        const { data: exceptionCounts } = await supabase
            .from('calendar_dates')
            .select('exception_type')
            .limit(1000);

        const counts = {};
        exceptionCounts?.forEach(e => {
            counts[e.exception_type] = (counts[e.exception_type] || 0) + 1;
        });

        res.json({
            success: true,
            sampleDates: sampleDates,
            searchResults: searchResults,
            exceptionTypeCounts: counts,
            hint: "Vérifiez le format des dates. GTFS utilise YYYYMMDD (ex: 20260210)"
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Liste des stations
app.get('/api/stations', async (req, res) => {
    try {
        const { search } = req.query;

        let query = supabase
            .from('stops')
            .select('stop_id, stop_name, stop_lat, stop_lon')
            .order('stop_name', { ascending: true })
            .limit(100);

        if (search) {
            query = query.ilike('stop_name', `%${search}%`);
        }

        const { data, error } = await query;
        if (error) throw error;

        res.json({
            success: true,
            count: data.length,
            stations: data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Fonction utilitaire pour calculer la durée
function calculateDuration(departTime, arrivalTime) {
    try {
        const [dh, dm] = departTime.split(':').map(Number);
        const [ah, am] = arrivalTime.split(':').map(Number);

        let durationMinutes = (ah * 60 + am) - (dh * 60 + dm);
        if (durationMinutes < 0) durationMinutes += 24 * 60; // Gestion passage minuit

        const hours = Math.floor(durationMinutes / 60);
        const minutes = durationMinutes % 60;

        return `${hours}h${minutes.toString().padStart(2, '0')}`;
    } catch (e) {
        return 'N/A';
    }
}

// Gestion des erreurs 404
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée',
        availableRoutes: [
            'GET /',
            'GET /health',
            'GET /api/available-dates',
            'GET /api/trains?from=Paris&to=Nantes&date=2026-07-10',
            'GET /api/stations?search=Paris',
            'GET /api/debug/dates?date=2026-07-10'
        ]
    });
});

// Gestion des erreurs serveur
app.use((err, req, res, next) => {
    console.error('💥 Erreur serveur:', err);
    res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur',
        details: err.message
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur GTFS démarré sur le port ${PORT}`);
    console.log(`📍 URL locale: http://localhost:${PORT}`);
    console.log(`🗄️  Connecté à Supabase`);
    console.log(`✅ Prêt à recevoir des requêtes !`);
});