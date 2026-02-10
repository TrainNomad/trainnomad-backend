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
        version: '4.0 - GTFS avec Correspondances'
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
// NOUVELLE ROUTE AVEC CORRESPONDANCES
// ===================================
app.get('/api/trains/search', async (req, res) => {
    try {
        const { from, to, date, maxTransfers = 1, minTransferTime = 30 } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ 
                error: "Paramètres from, to et date requis",
                example: "/api/trains/search?from=Paris&to=Marseille&date=2026-07-10&maxTransfers=1"
            });
        }

        // Convertir la date au format GTFS (YYYYMMDD)
        const gtfsDate = date.replace(/-/g, '');

        // 1. Récupérer les services actifs pour la date
        const { data: activeServices, error: sError } = await supabase
            .from('calendar_dates')
            .select('service_id')
            .eq('date', gtfsDate)
            .eq('exception_type', 1);

        if (sError) throw sError;
        
        const serviceIds = activeServices.map(s => s.service_id);
        if (serviceIds.length === 0) {
            return res.json({ 
                success: true, 
                count: 0, 
                message: "Aucun service trouvé pour cette date",
                hint: `Format de date testé: ${gtfsDate}`
            });
        }

        // 2. Trouver les IDs des gares
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const originStops = stops.filter(s => 
            s.stop_name.toLowerCase().includes(from.toLowerCase())
        );
        const destStops = stops.filter(s => 
            s.stop_name.toLowerCase().includes(to.toLowerCase())
        );

        if (originStops.length === 0 || destStops.length === 0) {
            return res.json({
                success: false,
                error: "Gare de départ ou d'arrivée introuvable",
                found: {
                    origin: originStops.map(s => s.stop_name),
                    destination: destStops.map(s => s.stop_name)
                }
            });
        }

        const originIds = originStops.map(s => s.stop_id);
        const destIds = destStops.map(s => s.stop_id);

        // 3. Rechercher les trajets directs
        const directTrains = await findDirectTrains(originIds, destIds, serviceIds);

        // 4. Rechercher les trajets avec correspondances si demandé
        let transferTrains = [];
        if (parseInt(maxTransfers) >= 1) {
            transferTrains = await findTrainsWithTransfers(
                originIds, 
                destIds, 
                serviceIds, 
                parseInt(maxTransfers),
                parseInt(minTransferTime)
            );
        }

        // 5. Combiner et trier tous les résultats
        const allJourneys = [
            ...directTrains.map(t => ({ ...t, type: 'direct', transfers: 0 })),
            ...transferTrains
        ].sort((a, b) => {
            // Trier par heure de départ
            return a.departure_time.localeCompare(b.departure_time);
        });

        res.json({
            success: true,
            count: allJourneys.length,
            date: date,
            from: originStops[0].stop_name,
            to: destStops[0].stop_name,
            summary: {
                direct: directTrains.length,
                withTransfers: transferTrains.length
            },
            journeys: allJourneys
        });

    } catch (error) {
        console.error('Erreur recherche:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message,
            stack: process.env.NODE_ENV === 'development' ? error.stack : undefined
        });
    }
});

// ===================================
// FONCTIONS UTILITAIRES
// ===================================

/**
 * Recherche les trajets directs entre deux gares
 */
async function findDirectTrains(originIds, destIds, serviceIds) {
    const { data: results, error } = await supabase
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
        .in('stop_id', [...originIds, ...destIds])
        .in('trips.service_id', serviceIds);

    if (error) throw error;

    // Groupement par trajet
    const tripsMap = {};
    results.forEach(row => {
        if (!tripsMap[row.trip_id]) {
            tripsMap[row.trip_id] = { dep: null, arr: null };
        }
        if (originIds.includes(row.stop_id)) {
            tripsMap[row.trip_id].dep = row;
        } else if (destIds.includes(row.stop_id)) {
            tripsMap[row.trip_id].arr = row;
        }
    });

    return Object.values(tripsMap)
        .filter(t => t.dep && t.arr && t.dep.stop_sequence < t.arr.stop_sequence)
        .map(t => ({
            train_number: t.dep.trips.trip_headsign || t.dep.trips.routes.route_short_name || 'N/A',
            train_type: t.dep.trips.routes.route_long_name || "Train",
            departure_station: t.dep.stops.stop_name,
            arrival_station: t.arr.stops.stop_name,
            departure_time: t.dep.departure_time,
            arrival_time: t.arr.arrival_time,
            duration: calculateDuration(t.dep.departure_time, t.arr.arrival_time)
        }));
}

/**
 * Recherche les trajets avec correspondances
 */
async function findTrainsWithTransfers(originIds, destIds, serviceIds, maxTransfers, minTransferTime) {
    if (maxTransfers < 1) return [];

    const journeys = [];

    // Récupérer tous les trains partant de l'origine
    const { data: fromOrigin, error: e1 } = await supabase
        .from('stop_times')
        .select(`
            trip_id,
            arrival_time,
            departure_time,
            stop_sequence,
            stop_id,
            stops(stop_id, stop_name),
            trips!inner (
                trip_headsign,
                route_id,
                service_id,
                routes(route_short_name, route_long_name)
            )
        `)
        .in('trips.service_id', serviceIds)
        .order('departure_time', { ascending: true });

    if (e1) throw e1;

    // Grouper par trip_id pour avoir tous les arrêts de chaque train
    const tripsByTripId = {};
    fromOrigin.forEach(row => {
        if (!tripsByTripId[row.trip_id]) {
            tripsByTripId[row.trip_id] = [];
        }
        tripsByTripId[row.trip_id].push(row);
    });

    // Pour chaque train partant de l'origine
    Object.values(tripsByTripId).forEach(trip => {
        const sortedStops = trip.sort((a, b) => a.stop_sequence - b.stop_sequence);
        
        // Trouver l'arrêt de départ (origine)
        const departureStop = sortedStops.find(stop => 
            originIds.includes(stop.stop_id)
        );

        if (!departureStop) return;

        // Pour chaque arrêt intermédiaire de ce train (gares de correspondance potentielles)
        sortedStops.forEach(transferStop => {
            // Ignorer les arrêts avant le départ ou à la destination finale
            if (transferStop.stop_sequence <= departureStop.stop_sequence) return;
            if (destIds.includes(transferStop.stop_id)) return;

            const transferStopId = transferStop.stop_id;
            const arrivalAtTransfer = transferStop.arrival_time;

            // Chercher les trains partant de cette gare de correspondance vers la destination
            Object.values(tripsByTripId).forEach(secondTrip => {
                if (secondTrip[0].trip_id === trip[0].trip_id) return; // Pas le même train

                const secondSortedStops = secondTrip.sort((a, b) => a.stop_sequence - b.stop_sequence);

                // Trouver l'arrêt de correspondance dans le 2ème train
                const transferDeparture = secondSortedStops.find(stop => 
                    stop.stop_id === transferStopId
                );

                if (!transferDeparture) return;

                // Trouver l'arrivée finale
                const finalArrival = secondSortedStops.find(stop => 
                    destIds.includes(stop.stop_id) && 
                    stop.stop_sequence > transferDeparture.stop_sequence
                );

                if (!finalArrival) return;

                // Vérifier le temps de correspondance
                const transferTimeMinutes = calculateTransferTimeMinutes(
                    arrivalAtTransfer, 
                    transferDeparture.departure_time
                );

                if (transferTimeMinutes < minTransferTime || transferTimeMinutes > 360) {
                    return; // Correspondance trop courte ou trop longue (>6h)
                }

                // Ajouter ce trajet avec correspondance
                journeys.push({
                    type: 'with_transfer',
                    transfers: 1,
                    departure_station: departureStop.stops.stop_name,
                    arrival_station: finalArrival.stops.stop_name,
                    departure_time: departureStop.departure_time,
                    arrival_time: finalArrival.arrival_time,
                    duration: calculateDuration(departureStop.departure_time, finalArrival.arrival_time),
                    legs: [
                        {
                            train_number: trip[0].trips.trip_headsign || trip[0].trips.routes.route_short_name || 'N/A',
                            train_type: trip[0].trips.routes.route_long_name || "Train",
                            departure_station: departureStop.stops.stop_name,
                            arrival_station: transferStop.stops.stop_name,
                            departure_time: departureStop.departure_time,
                            arrival_time: arrivalAtTransfer,
                            duration: calculateDuration(departureStop.departure_time, arrivalAtTransfer)
                        },
                        {
                            transfer_time: `${transferTimeMinutes} min`,
                            station: transferStop.stops.stop_name
                        },
                        {
                            train_number: secondTrip[0].trips.trip_headsign || secondTrip[0].trips.routes.route_short_name || 'N/A',
                            train_type: secondTrip[0].trips.routes.route_long_name || "Train",
                            departure_station: transferStop.stops.stop_name,
                            arrival_station: finalArrival.stops.stop_name,
                            departure_time: transferDeparture.departure_time,
                            arrival_time: finalArrival.arrival_time,
                            duration: calculateDuration(transferDeparture.departure_time, finalArrival.arrival_time)
                        }
                    ]
                });
            });
        });
    });

    return journeys;
}

/**
 * Calcule le temps de correspondance en minutes
 */
function calculateTransferTimeMinutes(arrivalTime, departureTime) {
    try {
        const [ah, am] = arrivalTime.split(':').map(Number);
        const [dh, dm] = departureTime.split(':').map(Number);

        let transferMinutes = (dh * 60 + dm) - (ah * 60 + am);
        
        // Gestion du passage de minuit
        if (transferMinutes < 0) {
            transferMinutes += 24 * 60;
        }

        return transferMinutes;
    } catch (e) {
        return 0;
    }
}

/**
 * Calcule la durée entre deux horaires
 */
function calculateDuration(departTime, arrivalTime) {
    try {
        const [dh, dm] = departTime.split(':').map(Number);
        const [ah, am] = arrivalTime.split(':').map(Number);

        let durationMinutes = (ah * 60 + am) - (dh * 60 + dm);
        if (durationMinutes < 0) durationMinutes += 24 * 60;

        const hours = Math.floor(durationMinutes / 60);
        const minutes = durationMinutes % 60;

        return `${hours}h${minutes.toString().padStart(2, '0')}`;
    } catch (e) {
        return 'N/A';
    }
}

// ===================================
// ROUTE ORIGINALE (trajets directs uniquement)
// ===================================
app.get('/api/trains', async (req, res) => {
    try {
        const { from, to, date } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ error: "Paramètres from, to et date requis" });
        }

        // Convertir la date au format GTFS
        const gtfsDate = date.replace(/-/g, '');

        // 1. Récupérer les services actifs pour la date
        const { data: activeServices, error: sError } = await supabase
            .from('calendar_dates')
            .select('service_id')
            .eq('date', gtfsDate)
            .eq('exception_type', 1);

        if (sError) throw sError;
        
        const serviceIds = activeServices.map(s => s.service_id);
        if (serviceIds.length === 0) {
            return res.json({ success: true, count: 0, message: "Aucun service trouvé pour cette date" });
        }

        // 2. Trouver les IDs des gares
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const depIds = stops.filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase())).map(s => s.stop_id);
        const arrIds = stops.filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase())).map(s => s.stop_id);

        // 3. Requête principale
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
            .in('trips.service_id', serviceIds);

        if (rError) throw rError;

        // 4. Groupement par trajet
        const tripsMap = {};
        results.forEach(row => {
            if (!tripsMap[row.trip_id]) tripsMap[row.trip_id] = { dep: null, arr: null };
            if (depIds.includes(row.stop_id)) tripsMap[row.trip_id].dep = row;
            else if (arrIds.includes(row.stop_id)) tripsMap[row.trip_id].arr = row;
        });

        const trains = Object.values(tripsMap)
            .filter(t => t.dep && t.arr && t.dep.stop_sequence < t.arr.stop_sequence)
            .map(t => ({
                train_number: t.dep.trips.trip_headsign || t.dep.trips.routes.route_short_name || 'N/A',
                type: t.dep.trips.routes.route_long_name || "Train",
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
        const { data: dates, error } = await supabase
            .from('calendar_dates')
            .select('date')
            .eq('exception_type', 1)
            .order('date', { ascending: true });

        if (error) throw error;

        const uniqueDates = [...new Set(dates.map(d => d.date))];
        const minDate = uniqueDates[0];
        const maxDate = uniqueDates[uniqueDates.length - 1];

        const byMonth = {};
        uniqueDates.forEach(date => {
            const month = date.substring(0, 7);
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
            'GET /api/trains/search?from=Paris&to=Marseille&date=2026-07-10&maxTransfers=1&minTransferTime=30',
            'GET /api/stations?search=Paris'
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
    console.log(`🔄 Correspondances activées !`);
});