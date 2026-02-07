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
        version: '2.1 - GTFS Debug'
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

// Version DEBUG de la recherche de trains (avec logs détaillés)
app.get('/api/trains/debug', async (req, res) => {
    const debug = [];
    
    try {
        const { from, to, date } = req.query;

        debug.push(`📥 Paramètres reçus: from="${from}", to="${to}", date="${date}"`);

        if (!from || !to || !date) {
            return res.status(400).json({
                success: false,
                error: 'Paramètres manquants',
                required: ['from', 'to', 'date'],
                received: { from, to, date },
                debug
            });
        }

        // ÉTAPE 1: Trouver les gares de départ
        debug.push('🔍 Étape 1: Recherche des gares de départ...');
        const { data: departStops, error: error1 } = await supabase
            .from('stops')
            .select('stop_id, stop_name, location_type')
            .ilike('stop_name', `%${from}%`);

        if (error1) {
            debug.push(`❌ Erreur stops départ: ${error1.message}`);
            return res.json({ success: false, error: error1.message, debug });
        }

        debug.push(`✅ Gares départ trouvées: ${departStops?.length || 0}`);
        debug.push(JSON.stringify(departStops, null, 2));

        if (!departStops || departStops.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucune gare trouvée pour "${from}"`,
                debug
            });
        }

        // ÉTAPE 2: Trouver les gares d'arrivée
        debug.push('🔍 Étape 2: Recherche des gares d\'arrivée...');
        const { data: arriveeStops, error: error2 } = await supabase
            .from('stops')
            .select('stop_id, stop_name, location_type')
            .ilike('stop_name', `%${to}%`);

        if (error2) {
            debug.push(`❌ Erreur stops arrivée: ${error2.message}`);
            return res.json({ success: false, error: error2.message, debug });
        }

        debug.push(`✅ Gares arrivée trouvées: ${arriveeStops?.length || 0}`);
        debug.push(JSON.stringify(arriveeStops, null, 2));

        if (!arriveeStops || arriveeStops.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucune gare trouvée pour "${to}"`,
                debug
            });
        }

        const departStopIds = departStops.map(s => s.stop_id);
        const arriveeStopIds = arriveeStops.map(s => s.stop_id);

        // ÉTAPE 3: Trouver les services pour cette date
        debug.push(`🔍 Étape 3: Recherche des services pour ${date}...`);
        const { data: services, error: error3 } = await supabase
            .from('calendar_dates')
            .select('service_id, exception_type')
            .eq('date', date);

        if (error3) {
            debug.push(`❌ Erreur calendar_dates: ${error3.message}`);
            return res.json({ success: false, error: error3.message, debug });
        }

        debug.push(`✅ Services trouvés: ${services?.length || 0}`);
        debug.push(JSON.stringify(services, null, 2));

        if (!services || services.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucun service disponible le ${date}`,
                debug
            });
        }

        // Filtrer seulement les services actifs (exception_type = 1)
        const activeServices = services.filter(s => s.exception_type === 1);
        const serviceIds = activeServices.map(s => s.service_id);

        debug.push(`✅ Services actifs (exception_type=1): ${serviceIds.length}`);

        if (serviceIds.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: `Aucun service actif le ${date}`,
                debug
            });
        }

        // ÉTAPE 4: Trouver les trips
        debug.push('🔍 Étape 4: Recherche des trips...');
        const { data: trips, error: error4 } = await supabase
            .from('trips')
            .select('trip_id, trip_headsign, route_id, service_id')
            .in('service_id', serviceIds);

        if (error4) {
            debug.push(`❌ Erreur trips: ${error4.message}`);
            return res.json({ success: false, error: error4.message, debug });
        }

        debug.push(`✅ Trips trouvés: ${trips?.length || 0}`);

        if (!trips || trips.length === 0) {
            return res.json({
                success: true,
                count: 0,
                message: 'Aucun trip trouvé',
                debug
            });
        }

        const tripIds = trips.map(t => t.trip_id);
        debug.push(`Trip IDs: ${tripIds.slice(0, 5).join(', ')}...`);

        // ÉTAPE 5: Trouver les stop_times pour les départs
        debug.push('🔍 Étape 5: Recherche des horaires de départ...');
        const { data: departTimes, error: error5 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, departure_time')
            .in('trip_id', tripIds)
            .in('stop_id', departStopIds);

        if (error5) {
            debug.push(`❌ Erreur stop_times départ: ${error5.message}`);
            return res.json({ success: false, error: error5.message, debug });
        }

        debug.push(`✅ Horaires départ trouvés: ${departTimes?.length || 0}`);

        // ÉTAPE 6: Trouver les stop_times pour les arrivées
        debug.push('🔍 Étape 6: Recherche des horaires d\'arrivée...');
        const { data: arriveeTimes, error: error6 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time')
            .in('trip_id', tripIds)
            .in('stop_id', arriveeStopIds);

        if (error6) {
            debug.push(`❌ Erreur stop_times arrivée: ${error6.message}`);
            return res.json({ success: false, error: error6.message, debug });
        }

        debug.push(`✅ Horaires arrivée trouvés: ${arriveeTimes?.length || 0}`);

        // ÉTAPE 7: Matcher les trips
        debug.push('🔍 Étape 7: Matching des trips...');
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

        departTimesMap.forEach((depts, tripId) => {
            const arrs = arriveeTimesMap.get(tripId);
            if (!arrs) return;

            depts.forEach(dept => {
                arrs.forEach(arr => {
                    if (arr.stop_sequence > dept.stop_sequence) {
                        const trip = trips.find(t => t.trip_id === tripId);
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

        debug.push(`✅ Trips valides: ${validTrips.length}`);

        // ÉTAPE 8: Enrichir
        debug.push('🔍 Étape 8: Enrichissement des données...');
        const enrichedTrips = [];

        for (const trip of validTrips) {
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

            const { data: route } = await supabase
                .from('routes')
                .select('route_short_name, route_long_name')
                .eq('route_id', trip.route_id)
                .single();

            enrichedTrips.push({
                trip_id: trip.trip_id,
                train_name: route?.route_short_name || trip.trip_headsign,
                train_type: route?.route_long_name || '',
                depart_station: departStop?.stop_name || trip.depart_stop_id,
                arrival_station: arriveeStop?.stop_name || trip.arrivee_stop_id,
                depart_time: trip.depart_time,
                arrival_time: trip.arrival_time,
                duration: calculateDuration(trip.depart_time, trip.arrival_time),
                date: date
            });
        }

        enrichedTrips.sort((a, b) => a.depart_time.localeCompare(b.depart_time));

        debug.push(`✅ Résultats finaux: ${enrichedTrips.length}`);

        res.json({
            success: true,
            count: enrichedTrips.length,
            query: { from, to, date },
            data: enrichedTrips,
            debug
        });

    } catch (error) {
        debug.push(`💥 Erreur fatale: ${error.message}`);
        res.status(500).json({
            success: false,
            error: error.message,
            debug
        });
    }
});

// Exemple de route pour rechercher un trajet : /recherche?depart=Rennes&arrivee=Paris&date=20240520
app.get('/recherche', async (req, res) => {
    const { depart, arrivee, date } = req.query;

    if (!depart || !arrivee || !date) {
        return res.status(400).json({ error: "Paramètres depart, arrivee et date requis." });
    }

    // Cette requête fait tout le travail de jointure GTFS
    const { data, error } = await supabase
        .from('stop_times')
        .select(`
            trip_id,
            departure_time,
            stop:stops!stop_id (stop_name),
            trips!inner (
                route_id,
                route:routes (route_short_name, route_long_name),
                calendar:calendar_dates!inner (date)
            ),
            destination:stop_times!inner (
                arrival_time,
                stop:stops!stop_id (stop_name)
            )
        `)
        // 1. Filtrer par le nom de la gare de départ
        .eq('stop.stop_name', depart)
        // 2. Filtrer par le nom de la gare d'arrivée (via la jointure destination)
        .eq('destination.stop.stop_name', arrivee)
        // 3. Filtrer par la date (format YYYYMMDD souvent dans le GTFS)
        .eq('trips.calendar.date', date)
        // 4. S'assurer que le départ est AVANT l'arrivée dans le trajet
        .lt('stop_sequence', 'destination.stop_sequence') 
        .order('departure_time', { ascending: true });

    if (error) return res.status(500).json(error);
    res.json(data);
});


// Version SIMPLIFIÉE de la recherche (sans debug)
app.get('/api/trains', async (req, res) => {
    try {
        const { from, to, date } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ error: "Paramètres from, to et date requis" });
        }

        // 1. Formatage de la date : 2026-02-10 -> 20260210
        const searchDate = date.replace(/-/g, '');

        // 2. Requête Supabase
        // On passe par stop_times pour rejoindre stops (le quai) 
        // ET on vérifie si le quai appartient à une gare (parent_station) qui correspond au nom
        const { data, error } = await supabase
            .from('stop_times')
            .select(`
                departure_time,
                arrival_time,
                stop_sequence,
                stops!inner (
                    stop_name,
                    parent_station
                ),
                trips!inner (
                    trip_id,
                    route_id,
                    service_id,
                    routes (route_short_name, route_long_name),
                    calendar_dates!inner (date)
                )
            `)
            .eq('trips.calendar_dates.date', searchDate)
            .or(`stop_name.ilike.%${from}%,parent_station.in.(select stop_id from stops where stop_name ilike '%${from}%')`)
            .order('departure_time', { ascending: true });

        if (error) throw error;

        // 3. Filtrage intelligent
        // Comme le GTFS est complexe, on s'assure de ne renvoyer que les trajets 
        // où le train s'arrête aussi à la destination 'to' plus tard.
        const tripsWithDestination = data.filter(item => item.trips !== null);

        res.json({
            success: true,
            date: searchDate,
            count: tripsWithDestination.length,
            data: tripsWithDestination
        });

    } catch (error) {
        console.error('Erreur API Trains:', error);
        res.status(500).json({ success: false, error: error.message });
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
            data: data
        });

    } catch (error) {
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Fonction utilitaire
function calculateDuration(departTime, arrivalTime) {
    const [dh, dm] = departTime.split(':').map(Number);
    const [ah, am] = arrivalTime.split(':').map(Number);

    let durationMinutes = (ah * 60 + am) - (dh * 60 + dm);
    if (durationMinutes < 0) durationMinutes += 24 * 60;

    const hours = Math.floor(durationMinutes / 60);
    const minutes = durationMinutes % 60;

    return `${hours}h${minutes.toString().padStart(2, '0')}`;
}

// Gestion des erreurs
app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée',
        availableRoutes: [
            'GET /',
            'GET /health',
            'GET /api/trains?from=XXX&to=YYY&date=YYYY-MM-DD',
            'GET /api/trains/debug?from=XXX&to=YYY&date=YYYY-MM-DD',
            'GET /api/stations?search=XXX'
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
    console.log(`🚀 Serveur GTFS Debug démarré sur le port ${PORT}`);
    console.log(`📍 URL locale: http://localhost:${PORT}`);
    console.log(`🗄️  Connecté à Supabase`);
    console.log(`✅ Prêt à recevoir des requêtes !`);
    console.log(`🐛 Mode debug disponible sur /api/trains/debug`);
});