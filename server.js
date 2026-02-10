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
        version: '5.0 - Pagination Optimisée + Théorie des Graphes'
    });
});

// Route de santé
app.get('/health', async (req, res) => {
    try {
        const checks = {
            stops: null,
            routes: null,
            trips: null,
            stop_times: null,
            calendar_dates: null
        };

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
// ROUTE PRINCIPALE AVEC PAGINATION
// ===================================
app.get('/api/trains', async (req, res) => {
    try {
        const { 
            from, 
            to, 
            date, 
            maxTransfers = 1, 
            minTransferTime = 20,
            startTime = "00:00:00",  // NOUVEAU: heure de début pour pagination
            limit = 10,              // NOUVEAU: nombre de résultats par page
            includeTransfers = 'true' // NOUVEAU: activer/désactiver les correspondances
        } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ 
                error: "Paramètres from, to et date requis",
                example: "/api/trains?from=Paris&to=Nantes&date=2026-07-10&startTime=08:00:00&limit=10"
            });
        }

        console.log(`🔍 Recherche: ${from} → ${to} @ ${date} à partir de ${startTime}`);

        // 1. Récupérer les services actifs
        const { data: activeServices, error: sError } = await supabase
            .from('calendar_dates')
            .select('service_id')
            .eq('date', date)
            .eq('exception_type', 1);

        if (sError) throw sError;
        
        const serviceIds = activeServices.map(s => s.service_id);
        if (serviceIds.length === 0) {
            return res.json({ 
                success: true, 
                count: 0, 
                message: "Aucun service trouvé pour cette date" 
            });
        }

        // 2. Trouver les IDs des gares
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const depIds = stops.filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase())).map(s => s.stop_id);
        const arrIds = stops.filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase())).map(s => s.stop_id);

        if (depIds.length === 0 || arrIds.length === 0) {
            return res.json({
                success: false,
                error: "Gare de départ ou d'arrivée introuvable"
            });
        }

        // 3. Rechercher les trajets directs (RAPIDE)
        const directTrains = await findDirectTrains(depIds, arrIds, serviceIds, startTime, parseInt(limit));

        // 4. Rechercher les correspondances si activé (PLUS LENT)
        let transferTrains = [];
        if (includeTransfers === 'true' && parseInt(maxTransfers) >= 1) {
            transferTrains = await findTrainsWithTransfers(
                depIds, 
                arrIds, 
                serviceIds, 
                parseInt(maxTransfers),
                parseInt(minTransferTime),
                startTime
            );
        }

        // 5. Combiner et dédupliquer
        const allJourneys = [
            ...directTrains.map(t => ({ ...t, type: 'direct', transfers: 0 })),
            ...transferTrains
        ];

        // Déduplication par heure de départ (arrondie à 5 min)
        const journeyMap = new Map();
        
        allJourneys.forEach(journey => {
            const depTime = journey.departure_time;
            const [hours, minutes] = depTime.split(':').map(Number);
            const roundedMinutes = Math.floor(minutes / 5) * 5;
            const key = `${journey.departure_station}-${hours}:${roundedMinutes.toString().padStart(2, '0')}`;
            
            const existing = journeyMap.get(key);
            
            if (!existing) {
                journeyMap.set(key, journey);
            } else {
                const existingDuration = parseDuration(existing.duration);
                const currentDuration = parseDuration(journey.duration);
                
                // Priorité: 1. Direct 2. Plus rapide
                if (journey.type === 'direct' && existing.type !== 'direct') {
                    journeyMap.set(key, journey);
                } else if (existing.type === 'direct' && journey.type !== 'direct') {
                    // Garder l'existant
                } else if (currentDuration < existingDuration) {
                    journeyMap.set(key, journey);
                }
            }
        });

        // Trier et limiter
        const uniqueJourneys = Array.from(journeyMap.values())
            .sort((a, b) => a.departure_time.localeCompare(b.departure_time))
            .slice(0, parseInt(limit));

        // Déterminer s'il y a plus de résultats
        const hasMore = uniqueJourneys.length === parseInt(limit);
        const nextStartTime = hasMore ? uniqueJourneys[uniqueJourneys.length - 1].departure_time : null;

        console.log(`✅ Retour de ${uniqueJourneys.length} trajets (directs: ${uniqueJourneys.filter(j => j.type === 'direct').length}, correspondances: ${uniqueJourneys.filter(j => j.type === 'with_transfer').length})`);

        res.json({
            success: true,
            count: uniqueJourneys.length,
            date: date,
            from: stops.find(s => depIds.includes(s.stop_id))?.stop_name,
            to: stops.find(s => arrIds.includes(s.stop_id))?.stop_name,
            pagination: {
                startTime: startTime,
                nextStartTime: nextStartTime,
                hasMore: hasMore,
                limit: parseInt(limit)
            },
            summary: {
                direct: uniqueJourneys.filter(j => j.type === 'direct').length,
                withTransfers: uniqueJourneys.filter(j => j.type === 'with_transfer').length,
                total: uniqueJourneys.length
            },
            trains: uniqueJourneys
        });

    } catch (error) {
        console.error('❌ Erreur recherche:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// ===================================
// FONCTIONS UTILITAIRES
// ===================================

/**
 * Recherche les trajets directs avec pagination
 */
async function findDirectTrains(originIds, destIds, serviceIds, startTime, limit) {
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
        .in('trips.service_id', serviceIds)
        .gte('departure_time', startTime) // PAGINATION
        .order('departure_time', { ascending: true })
        .limit(limit * 3); // Récupérer plus pour compenser les filtres

    if (error) throw error;

    // Groupement par trajet
    const tripsMap = {};
    results.forEach(row => {
        if (!tripsMap[row.trip_id]) {
            tripsMap[row.trip_id] = { dep: null, arr: null };
        }
        if (originIds.includes(row.stop_id)) {
            // Prendre le premier arrêt à l'origine
            if (!tripsMap[row.trip_id].dep || row.stop_sequence < tripsMap[row.trip_id].dep.stop_sequence) {
                tripsMap[row.trip_id].dep = row;
            }
        } else if (destIds.includes(row.stop_id)) {
            // Prendre le dernier arrêt à la destination
            if (!tripsMap[row.trip_id].arr || row.stop_sequence > tripsMap[row.trip_id].arr.stop_sequence) {
                tripsMap[row.trip_id].arr = row;
            }
        }
    });

    return Object.values(tripsMap)
        .filter(t => t.dep && t.arr && t.dep.stop_sequence < t.arr.stop_sequence && t.dep.departure_time >= startTime)
        .map(t => ({
            train_number: t.dep.trips.trip_headsign || t.dep.trips.routes.route_short_name || 'N/A',
            train_type: t.dep.trips.routes.route_long_name || "Train",
            departure_station: t.dep.stops.stop_name,
            arrival_station: t.arr.stops.stop_name,
            departure_time: t.dep.departure_time,
            arrival_time: t.arr.arrival_time,
            duration: calculateDuration(t.dep.departure_time, t.arr.arrival_time)
        }))
        .sort((a, b) => a.departure_time.localeCompare(b.departure_time));
}

/**
 * Recherche les trajets avec correspondances (THÉORIE DES GRAPHES)
 */
async function findTrainsWithTransfers(originIds, destIds, serviceIds, maxTransfers, minTransferTime, startTime) {
    if (maxTransfers < 1) return [];

    const journeys = [];

    try {
        // Q1: Trains partant de l'origine APRÈS startTime
        const { data: trainsFromOrigin, error: e1 } = await supabase
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
            .in('stop_id', originIds)
            .in('trips.service_id', serviceIds)
            .gte('departure_time', startTime) // PAGINATION
            .order('departure_time', { ascending: true })
            .limit(30);

        // Q2: Trains arrivant à la destination
        const { data: trainsToDestination, error: e2 } = await supabase
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
            .in('stop_id', destIds)
            .in('trips.service_id', serviceIds)
            .order('arrival_time', { ascending: true })
            .limit(100);

        if (e1 || e2) {
            console.error('Erreur requêtes parallèles:', e1 || e2);
            return [];
        }

        if (!trainsFromOrigin?.length || !trainsToDestination?.length) {
            return [];
        }

        // Récupérer tous les arrêts des trains
        const train1TripIds = [...new Set(trainsFromOrigin.map(t => t.trip_id))];
        
        const { data: allStopsFromA, error: e3 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time, departure_time, stops(stop_id, stop_name)')
            .in('trip_id', train1TripIds)
            .order('trip_id', { ascending: true })
            .order('stop_sequence', { ascending: true });

        const train2TripIds = [...new Set(trainsToDestination.map(t => t.trip_id))];
        
        const { data: allStopsToB, error: e4 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time, departure_time, stops(stop_id, stop_name)')
            .in('trip_id', train2TripIds)
            .order('trip_id', { ascending: true })
            .order('stop_sequence', { ascending: true });

        if (e3 || e4) {
            console.error('Erreur récupération arrêts:', e3 || e4);
            return [];
        }

        // Grouper par trip_id
        const stopsFromAByTrip = groupByTripId(allStopsFromA);
        const stopsToBByTrip = groupByTripId(allStopsToB);

        // Construction S(A) et E(B)
        const setA = new Map();
        
        trainsFromOrigin.forEach(departureStop => {
            const tripStops = stopsFromAByTrip[departureStop.trip_id];
            if (!tripStops) return;

            const originStop = tripStops.find(s => originIds.includes(s.stop_id));
            if (!originStop) return;

            tripStops.forEach(stop => {
                if (stop.stop_sequence <= originStop.stop_sequence) return;
                if (destIds.includes(stop.stop_id)) return;

                if (!setA.has(stop.stop_id)) {
                    setA.set(stop.stop_id, []);
                }

                setA.get(stop.stop_id).push({
                    trip_id: departureStop.trip_id,
                    departure_time_from_origin: originStop.departure_time,
                    arrival_time_at_transfer: stop.arrival_time,
                    origin_stop: originStop.stops.stop_name,
                    transfer_stop: stop.stops.stop_name,
                    trip_info: departureStop.trips
                });
            });
        });

        const setB = new Map();
        
        trainsToDestination.forEach(arrivalStop => {
            const tripStops = stopsToBByTrip[arrivalStop.trip_id];
            if (!tripStops) return;

            const destinationStop = tripStops.find(s => destIds.includes(s.stop_id));
            if (!destinationStop) return;

            tripStops.forEach(stop => {
                if (stop.stop_sequence >= destinationStop.stop_sequence) return;
                if (originIds.includes(stop.stop_id)) return;

                if (!setB.has(stop.stop_id)) {
                    setB.set(stop.stop_id, []);
                }

                setB.get(stop.stop_id).push({
                    trip_id: arrivalStop.trip_id,
                    departure_time: stop.departure_time,
                    arrival_time_at_destination: destinationStop.arrival_time,
                    transfer_stop: stop.stops.stop_name,
                    destination_stop: destinationStop.stops.stop_name,
                    trip_info: arrivalStop.trips
                });
            });
        });

        // Intersection C ∈ S(A) ∩ E(B)
        const commonStops = [...setA.keys()].filter(stopId => setB.has(stopId));

        console.log(`🔍 ${commonStops.length} gares de correspondance trouvées`);

        // Vérification contrainte temporelle
        for (const transferStopId of commonStops) {
            const trainsFromA = setA.get(transferStopId);
            const trainsToB = setB.get(transferStopId);

            for (const train1 of trainsFromA) {
                for (const train2 of trainsToB) {
                    if (train1.trip_id === train2.trip_id) continue;

                    const transferTimeMinutes = calculateTransferTimeMinutes(
                        train1.arrival_time_at_transfer,
                        train2.departure_time
                    );

                    if (transferTimeMinutes < minTransferTime) continue;
                    if (transferTimeMinutes > 360) continue;

                    journeys.push({
                        type: 'with_transfer',
                        transfers: 1,
                        departure_station: train1.origin_stop,
                        arrival_station: train2.destination_stop,
                        departure_time: train1.departure_time_from_origin,
                        arrival_time: train2.arrival_time_at_destination,
                        duration: calculateDuration(
                            train1.departure_time_from_origin,
                            train2.arrival_time_at_destination
                        ),
                        legs: [
                            {
                                train_number: train1.trip_info.trip_headsign || 
                                            train1.trip_info.routes.route_short_name || 'N/A',
                                train_type: train1.trip_info.routes.route_long_name || "Train",
                                departure_station: train1.origin_stop,
                                arrival_station: train1.transfer_stop,
                                departure_time: train1.departure_time_from_origin,
                                arrival_time: train1.arrival_time_at_transfer,
                                duration: calculateDuration(
                                    train1.departure_time_from_origin,
                                    train1.arrival_time_at_transfer
                                )
                            },
                            {
                                transfer_time: `${transferTimeMinutes} min`,
                                station: train1.transfer_stop
                            },
                            {
                                train_number: train2.trip_info.trip_headsign || 
                                            train2.trip_info.routes.route_short_name || 'N/A',
                                train_type: train2.trip_info.routes.route_long_name || "Train",
                                departure_station: train2.transfer_stop,
                                arrival_station: train2.destination_stop,
                                departure_time: train2.departure_time,
                                arrival_time: train2.arrival_time_at_destination,
                                duration: calculateDuration(
                                    train2.departure_time,
                                    train2.arrival_time_at_destination
                                )
                            }
                        ]
                    });
                }
            }
        }

        console.log(`✅ ${journeys.length} correspondances valides`);
        return journeys;

    } catch (error) {
        console.error('Erreur findTrainsWithTransfers:', error);
        return [];
    }
}

function groupByTripId(stops) {
    const grouped = {};
    stops.forEach(stop => {
        if (!grouped[stop.trip_id]) {
            grouped[stop.trip_id] = [];
        }
        grouped[stop.trip_id].push(stop);
    });
    return grouped;
}

function calculateTransferTimeMinutes(arrivalTime, departureTime) {
    try {
        const [ah, am] = arrivalTime.split(':').map(Number);
        const [dh, dm] = departureTime.split(':').map(Number);

        let transferMinutes = (dh * 60 + dm) - (ah * 60 + am);
        
        if (transferMinutes < 0) {
            transferMinutes += 24 * 60;
        }

        return transferMinutes;
    } catch (e) {
        return 0;
    }
}

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

function parseDuration(durationStr) {
    try {
        const match = durationStr.match(/(\d+)h(\d+)/);
        if (!match) return 9999;
        return parseInt(match[1]) * 60 + parseInt(match[2]);
    } catch (e) {
        return 9999;
    }
}

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
            'GET /api/trains?from=Paris&to=Nantes&date=2026-07-10&startTime=08:00:00&limit=10',
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
    console.log(`🔄 Correspondances + Pagination activées !`);
});