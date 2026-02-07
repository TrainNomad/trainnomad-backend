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
        version: '2.0 - GTFS'
    });
});

// Route de santé
app.get('/health', async (req, res) => {
    try {
        // Test de connexion avec les tables GTFS
        const checks = await Promise.all([
            supabase.from('stops').select('*', { count: 'exact', head: true }),
            supabase.from('routes').select('*', { count: 'exact', head: true }),
            supabase.from('trips').select('*', { count: 'exact', head: true }),
            supabase.from('stop_times').select('*', { count: 'exact', head: true })
        ]);

        const hasError = checks.some(check => check.error);
        if (hasError) throw new Error('Erreur de connexion à une table');

        res.json({
            status: 'healthy',
            database: 'connected',
            tables: {
                stops: checks[0].count,
                routes: checks[1].count,
                trips: checks[2].count,
                stop_times: checks[3].count
            }
        });
    } catch (error) {
        res.status(500).json({
            status: 'unhealthy',
            database: 'error',
            error: error.message
        });
    }
});

// ======================================
// ROUTES GTFS - RECHERCHE DE TRAINS
// ======================================

/**
 * Route principale : Rechercher des trains entre 2 gares pour une date
 * GET /api/trains?from=Paris&to=Nantes&date=2026-02-10
 */
app.get('/api/trains', async (req, res) => {
    try {
        const { from, to, date } = req.query;

        if (!from || !to) {
            return res.status(400).json({
                success: false,
                error: 'Les paramètres "from" et "to" sont requis'
            });
        }

        if (!date) {
            return res.status(400).json({
                success: false,
                error: 'Le paramètre "date" est requis (format: YYYY-MM-DD)'
            });
        }

        console.log(`🔍 Recherche trains: ${from} → ${to} le ${date}`);

        // 1. Trouver les stops correspondant au départ
        const { data: departStops, error: error1 } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .ilike('stop_name', `%${from}%`);

        if (error1) throw error1;
        if (!departStops || departStops.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucune gare trouvée pour "${from}"`,
                data: []
            });
        }

        // 2. Trouver les stops correspondant à l'arrivée
        const { data: arriveeStops, error: error2 } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .ilike('stop_name', `%${to}%`);

        if (error2) throw error2;
        if (!arriveeStops || arriveeStops.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucune gare trouvée pour "${to}"`,
                data: []
            });
        }

        const departStopIds = departStops.map(s => s.stop_id);
        const arriveeStopIds = arriveeStops.map(s => s.stop_id);

        console.log(`📍 Gares départ trouvées: ${departStopIds.length}`);
        console.log(`📍 Gares arrivée trouvées: ${arriveeStopIds.length}`);

        // 3. Trouver les services actifs pour cette date
        const { data: services, error: error3 } = await supabase
            .from('calendar_dates')
            .select('service_id')
            .eq('date', date)
            .eq('exception_type', 1); // 1 = service ajouté

        if (error3) throw error3;

        const serviceIds = services ? services.map(s => s.service_id) : [];
        console.log(`📅 Services actifs: ${serviceIds.length}`);

        if (serviceIds.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucun service disponible le ${date}`,
                data: []
            });
        }

        // 4. Trouver les trips avec ces services
        const { data: activeTrips, error: error4 } = await supabase
            .from('trips')
            .select('trip_id, trip_headsign, route_id')
            .in('service_id', serviceIds);

        if (error4) throw error4;
        if (!activeTrips || activeTrips.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: 'Aucun trip trouvé pour cette date',
                data: []
            });
        }

        const tripIds = activeTrips.map(t => t.trip_id);
        console.log(`🚂 Trips actifs: ${tripIds.length}`);

        // 5. Trouver les stop_times pour le départ
        const { data: departTimes, error: error5 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, departure_time')
            .in('trip_id', tripIds)
            .in('stop_id', departStopIds);

        if (error5) throw error5;

        // 6. Trouver les stop_times pour l'arrivée
        const { data: arriveeTimes, error: error6 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time')
            .in('trip_id', tripIds)
            .in('stop_id', arriveeStopIds);

        if (error6) throw error6;

        // 7. Matcher les trips qui passent par les deux gares dans le bon ordre
        const validTrips = [];
        const departTimesMap = new Map();
        const arriveeTimesMap = new Map();

        departTimes.forEach(dt => {
            if (!departTimesMap.has(dt.trip_id)) {
                departTimesMap.set(dt.trip_id, []);
            }
            departTimesMap.get(dt.trip_id).push(dt);
        });

        arriveeTimes.forEach(at => {
            if (!arriveeTimesMap.has(at.trip_id)) {
                arriveeTimesMap.set(at.trip_id, []);
            }
            arriveeTimesMap.get(at.trip_id).push(at);
        });

        // Pour chaque trip, vérifier qu'il passe bien par départ PUIS arrivée
        departTimesMap.forEach((depts, tripId) => {
            const arrs = arriveeTimesMap.get(tripId);
            if (!arrs) return;

            depts.forEach(dept => {
                arrs.forEach(arr => {
                    // Vérifier que l'arrivée est après le départ
                    if (arr.stop_sequence > dept.stop_sequence) {
                        const trip = activeTrips.find(t => t.trip_id === tripId);
                        validTrips.push({
                            trip_id: tripId,
                            trip_headsign: trip?.trip_headsign || '',
                            route_id: trip?.route_id || '',
                            depart_stop_id: dept.stop_id,
                            arrivee_stop_id: arr.stop_id,
                            depart_time: dept.departure_time,
                            arrival_time: arr.arrival_time,
                            depart_sequence: dept.stop_sequence,
                            arrival_sequence: arr.stop_sequence
                        });
                    }
                });
            });
        });

        console.log(`✅ Trajets valides trouvés: ${validTrips.length}`);

        // 8. Enrichir avec les noms des gares et routes
        const enrichedTrips = await Promise.all(validTrips.map(async (trip) => {
            // Récupérer les noms des gares
            const { data: departStop } = await supabase
                .from('stops')
                .select('stop_name')
                .eq('stop_id', trip.depart_stop_id)
                .single();

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

            return {
                trip_id: trip.trip_id,
                train_name: route?.route_short_name || trip.trip_headsign,
                train_type: route?.route_long_name || '',
                depart_station: departStop?.stop_name || trip.depart_stop_id,
                arrival_station: arriveeStop?.stop_name || trip.arrivee_stop_id,
                depart_time: trip.depart_time,
                arrival_time: trip.arrival_time,
                duration: calculateDuration(trip.depart_time, trip.arrival_time),
                date: date
            };
        }));

        // Trier par heure de départ
        enrichedTrips.sort((a, b) => a.depart_time.localeCompare(b.depart_time));

        res.json({
            success: true,
            count: enrichedTrips.length,
            query: { from, to, date },
            data: enrichedTrips
        });

    } catch (error) {
        console.error('❌ Erreur recherche trains:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Détails complets d'un trip (tous les arrêts)
 * GET /api/trips/:trip_id
 */
app.get('/api/trips/:trip_id', async (req, res) => {
    try {
        const { trip_id } = req.params;

        // Récupérer les infos du trip
        const { data: trip, error: error1 } = await supabase
            .from('trips')
            .select('*, routes(*)')
            .eq('trip_id', trip_id)
            .single();

        if (error1) throw error1;
        if (!trip) {
            return res.status(404).json({
                success: false,
                error: 'Trip non trouvé'
            });
        }

        // Récupérer tous les stop_times de ce trip
        const { data: stopTimes, error: error2 } = await supabase
            .from('stop_times')
            .select('*')
            .eq('trip_id', trip_id)
            .order('stop_sequence', { ascending: true });

        if (error2) throw error2;

        // Enrichir avec les noms des gares
        const enrichedStops = await Promise.all(stopTimes.map(async (st) => {
            const { data: stop } = await supabase
                .from('stops')
                .select('stop_name, stop_lat, stop_lon')
                .eq('stop_id', st.stop_id)
                .single();

            return {
                sequence: st.stop_sequence,
                station: stop?.stop_name || st.stop_id,
                arrival_time: st.arrival_time,
                departure_time: st.departure_time,
                coordinates: stop ? {
                    lat: stop.stop_lat,
                    lon: stop.stop_lon
                } : null
            };
        }));

        res.json({
            success: true,
            data: {
                trip_id: trip.trip_id,
                headsign: trip.trip_headsign,
                route: trip.routes ? {
                    name: trip.routes.route_short_name,
                    long_name: trip.routes.route_long_name
                } : null,
                stops: enrichedStops
            }
        });

    } catch (error) {
        console.error('❌ Erreur récupération trip:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Liste de toutes les gares/stations
 * GET /api/stations?search=Paris
 */
app.get('/api/stations', async (req, res) => {
    try {
        const { search } = req.query;

        let query = supabase
            .from('stops')
            .select('stop_id, stop_name, stop_lat, stop_lon')
            .eq('location_type', 1) // Seulement les stations (pas les arrêts individuels)
            .order('stop_name', { ascending: true });

        if (search) {
            query = query.ilike('stop_name', `%${search}%`);
        }

        const { data, error } = await query.limit(100);

        if (error) throw error;

        res.json({
            success: true,
            count: data.length,
            data: data
        });

    } catch (error) {
        console.error('❌ Erreur récupération stations:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

/**
 * Horaires d'une gare spécifique pour une date
 * GET /api/stations/:stop_id/schedule?date=2026-02-10
 */
app.get('/api/stations/:stop_id/schedule', async (req, res) => {
    try {
        const { stop_id } = req.params;
        const { date } = req.query;

        if (!date) {
            return res.status(400).json({
                success: false,
                error: 'Le paramètre "date" est requis'
            });
        }

        // Récupérer les infos de la station
        const { data: station, error: error1 } = await supabase
            .from('stops')
            .select('*')
            .eq('stop_id', stop_id)
            .single();

        if (error1) throw error1;

        // Récupérer tous les stop_times pour cette gare
        const { data: stopTimes, error: error2 } = await supabase
            .from('stop_times')
            .select('*, trips!inner(*, routes(*))')
            .eq('stop_id', stop_id)
            .order('departure_time', { ascending: true });

        if (error2) throw error2;

        res.json({
            success: true,
            station: station,
            count: stopTimes.length,
            data: stopTimes
        });

    } catch (error) {
        console.error('❌ Erreur horaires station:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ======================================
// FONCTIONS UTILITAIRES
// ======================================

/**
 * Calculer la durée entre deux horaires HH:MM:SS
 */
function calculateDuration(departTime, arrivalTime) {
    const [dh, dm, ds] = departTime.split(':').map(Number);
    const [ah, am, as] = arrivalTime.split(':').map(Number);

    const departMinutes = dh * 60 + dm;
    const arrivalMinutes = ah * 60 + am;

    let durationMinutes = arrivalMinutes - departMinutes;

    // Gérer le cas où le train arrive le lendemain
    if (durationMinutes < 0) {
        durationMinutes += 24 * 60;
    }

    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;

    return `${hours}h${minutes.toString().padStart(2, '0')}`;
}

// ======================================
// ROUTES DE COMPATIBILITÉ (anciennes)
// ======================================

// Rediriger /api/billets vers /api/trains
app.get('/api/billets', (req, res) => {
    const { depart, arrivee, date } = req.query;
    const newUrl = `/api/trains?from=${depart}&to=${arrivee}${date ? `&date=${date}` : ''}`;
    res.redirect(newUrl);
});

// ======================================
// GESTION DES ERREURS
// ======================================

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée',
        availableRoutes: [
            'GET /',
            'GET /health',
            'GET /api/trains?from=XXX&to=YYY&date=YYYY-MM-DD',
            'GET /api/trips/:trip_id',
            'GET /api/stations?search=XXX',
            'GET /api/stations/:stop_id/schedule?date=YYYY-MM-DD'
        ]
    });
});

app.use((err, req, res, next) => {
    console.error('Erreur serveur:', err);
    res.status(500).json({
        success: false,
        error: 'Erreur interne du serveur'
    });
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => {
    console.log(`🚀 Serveur GTFS démarré sur le port ${PORT}`);
    console.log(`📍 URL locale: http://localhost:${PORT}`);
    console.log(`🗄️  Connecté à Supabase (tables GTFS)`);
    console.log(`✅ Prêt à recevoir des requêtes !`);
});