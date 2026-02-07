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
            return res.status(400).json({ 
                success: false,
                error: "Paramètres from, to et date requis",
                example: "/api/trains?from=Paris&to=Nantes&date=2026-02-10"
            });
        }

        // 1. Formatage de la date : convertir vers le format de la BDD (avec tirets)
        // Si l'utilisateur envoie 20260210, on le convertit en 2026-02-10
        let searchDate = date;
        if (date.length === 8 && !date.includes('-')) {
            // Format YYYYMMDD -> YYYY-MM-DD
            searchDate = `${date.substring(0, 4)}-${date.substring(4, 6)}-${date.substring(6, 8)}`;
        }

        console.log('🔍 Recherche:', { from, to, date: searchDate });

        // 2. Trouver les gares de départ
        const { data: departStops, error: error1 } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .ilike('stop_name', `%${from}%`);

        if (error1) throw error1;
        if (!departStops || departStops.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucune gare trouvée pour "${from}"`
            });
        }

        // 3. Trouver les gares d'arrivée
        const { data: arriveeStops, error: error2 } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .ilike('stop_name', `%${to}%`);

        if (error2) throw error2;
        if (!arriveeStops || arriveeStops.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucune gare trouvée pour "${to}"`
            });
        }

        const departStopIds = departStops.map(s => s.stop_id);
        const arriveeStopIds = arriveeStops.map(s => s.stop_id);

        console.log('📍 Gares départ:', departStopIds.length);
        console.log('📍 Gares arrivée:', arriveeStopIds.length);

        // 4. Trouver les services actifs pour cette date (format YYYY-MM-DD)
        console.log('🔍 Recherche services pour la date:', searchDate);
        
        const { data: services, error: error3 } = await supabase
            .from('calendar_dates')
            .select('service_id, exception_type, date')
            .eq('date', searchDate)
            .eq('exception_type', 1); // 1 = service actif

        if (error3) throw error3;
        
        if (!services || services.length === 0) {
            // Donnons plus d'infos pour debug
            const { data: sampleDates } = await supabase
                .from('calendar_dates')
                .select('date, exception_type')
                .limit(5);
            
            return res.json({
                success: true,
                count: 0,
                message: `Aucun service disponible le ${searchDate}`,
                debug: {
                    searchedDate: searchDate,
                    sampleDatesInDB: sampleDates,
                    hint: "Vérifiez que la date existe dans calendar_dates avec exception_type=1"
                }
            });
        }

        const serviceIds = services.map(s => s.service_id);
        console.log('🗓️ Services actifs:', serviceIds.length);

        // 5. Trouver les trips pour ces services
        const { data: trips, error: error4 } = await supabase
            .from('trips')
            .select('trip_id, route_id, trip_headsign')
            .in('service_id', serviceIds);

        if (error4) throw error4;
        if (!trips || trips.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: 'Aucun train trouvé pour cette date'
            });
        }

        const tripIds = trips.map(t => t.trip_id);
        console.log('🚂 Trips trouvés:', tripIds.length);

        // 6. Trouver les horaires de départ
        const { data: departTimes, error: error5 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, departure_time')
            .in('trip_id', tripIds)
            .in('stop_id', departStopIds);

        if (error5) throw error5;

        // 7. Trouver les horaires d'arrivée
        const { data: arriveeTimes, error: error6 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time')
            .in('trip_id', tripIds)
            .in('stop_id', arriveeStopIds);

        if (error6) throw error6;

        console.log('⏰ Horaires départ:', departTimes?.length || 0);
        console.log('⏰ Horaires arrivée:', arriveeTimes?.length || 0);

        // 8. Matcher départ et arrivée
        const validTrips = [];
        departTimes?.forEach(dep => {
            arriveeTimes?.forEach(arr => {
                if (dep.trip_id === arr.trip_id && dep.stop_sequence < arr.stop_sequence) {
                    const trip = trips.find(t => t.trip_id === dep.trip_id);
                    validTrips.push({
                        trip_id: dep.trip_id,
                        route_id: trip?.route_id,
                        trip_headsign: trip?.trip_headsign,
                        depart_stop_id: dep.stop_id,
                        arrivee_stop_id: arr.stop_id,
                        depart_time: dep.departure_time,
                        arrival_time: arr.arrival_time,
                        depart_sequence: dep.stop_sequence,
                        arrival_sequence: arr.stop_sequence
                    });
                }
            });
        });

        console.log('✅ Trips valides:', validTrips.length);

        if (validTrips.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: 'Aucun trajet direct trouvé entre ces gares'
            });
        }

        // 9. Enrichir avec les noms de gares et routes
        const enrichedTrips = [];
        for (const trip of validTrips) {
            // Récupérer le nom de la gare de départ
            const { data: departStop } = await supabase
                .from('stops')
                .select('stop_name')
                .eq('stop_id', trip.depart_stop_id)
                .single();

            // Récupérer le nom de la gare d'arrivée
            const { data: arriveeStop } = await supabase
                .from('stops')
                .select('stop_name')
                .eq('stop_id', trip.arrivee_stop_id)
                .single();

            // Récupérer les infos de la route
            const { data: route } = await supabase
                .from('routes')
                .select('route_short_name, route_long_name')
                .eq('route_id', trip.route_id)
                .single();

            enrichedTrips.push({
                trip_id: trip.trip_id,
                train_number: route?.route_short_name || 'N/A',
                train_type: route?.route_long_name || trip.trip_headsign || 'Train',
                depart_station: departStop?.stop_name || trip.depart_stop_id,
                arrival_station: arriveeStop?.stop_name || trip.arrivee_stop_id,
                depart_time: trip.depart_time,
                arrival_time: trip.arrival_time,
                duration: calculateDuration(trip.depart_time, trip.arrival_time)
            });
        }

        // 10. Trier par heure de départ
        enrichedTrips.sort((a, b) => a.depart_time.localeCompare(b.depart_time));

        res.json({
            success: true,
            count: enrichedTrips.length,
            date: searchDate,
            query: { from, to, date: searchDate },
            trains: enrichedTrips
        });

    } catch (error) {
        console.error('❌ Erreur API Trains:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message 
        });
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