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
            return res.status(400).json({ error: "Paramètres from, to et date requis" });
        }

        // 1. Récupérer les services actifs pour la date (ex: 2026-02-10)
        // On ne fait pas de join, on récupère juste la liste des IDs
        const { data: activeServices, error: sError } = await supabase
            .from('calendar_dates')
            .select('service_id')
            .eq('date', date)
            .eq('exception_type', 1);

        if (sError) throw sError;
        
        const serviceIds = activeServices.map(s => s.service_id);
        if (serviceIds.length === 0) {
            return res.json({ success: true, count: 0, message: "Aucun service trouvé pour cette date" });
        }

        // 2. Trouver les IDs des gares de départ et d'arrivée
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const depIds = stops.filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase())).map(s => s.stop_id);
        const arrIds = stops.filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase())).map(s => s.stop_id);

        // 3. La requête principale : on filtre sur les serviceIds récupérés à l'étape 1
        const { data: results, error: rError } = await supabase
            .from('stop_times')
            .select(`
                trip_id,
                arrival_time,
                departure_time,
                stop_sequence,
                stop_id,
                stops(stop_name),
                trips!inner (
                    trip_headsign,
                    route_id,
                    service_id,
                    routes(route_short_name, route_long_name)
                )
            `)
            .in('stop_id', [...depIds, ...arrIds])
            .in('trips.service_id', serviceIds); // C'est ici qu'on fait la liaison "manuelle"

        if (rError) throw rError;

        // 4. Groupement par trajet (Départ -> Arrivée)
        const tripsMap = {};
        results.forEach(row => {
            if (!tripsMap[row.trip_id]) tripsMap[row.trip_id] = { dep: null, arr: null };
            if (depIds.includes(row.stop_id)) tripsMap[row.trip_id].dep = row;
            else if (arrIds.includes(row.stop_id)) tripsMap[row.trip_id].arr = row;
        });

        const trains = Object.values(tripsMap)
            .filter(t => t.dep && t.arr && t.dep.stop_sequence < t.arr.stop_sequence)
            .map(t => ({
                train_number: t.dep.trips.routes.route_short_name || 'N/A',
                type: t.dep.trips.routes.route_long_name || t.dep.trips.trip_headsign,
                departure_station: t.dep.stops.stop_name,
                arrival_station: t.arr.stops.stop_name,
                departure_time: t.dep.departure_time,
                arrival_time: t.arr.arrival_time,
                duration: calculateDuration(t.dep.departure_time, t.arr.arrival_time)
            }))
            .sort((a, b) => a.departure_time.localeCompare(b.departure_time));

        res.json({ success: true, count: trains.length, date, trains });

    } catch (error) {
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