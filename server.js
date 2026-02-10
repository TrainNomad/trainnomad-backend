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
// ROUTE PRINCIPALE DE RECHERCHE (Directs + Correspondances)
// ===================================
app.get('/api/trains', async (req, res) => {
    const { from, to, date, startTime = "00:00:00", limit = 8 } = req.query;
    try {
        const { from, to, date, maxTransfers = 1, minTransferTime = 30 } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ 
                error: "Paramètres from, to et date requis",
                example: "/api/trains?from=Paris&to=Nantes&date=2026-07-10&maxTransfers=1&minTransferTime=30"
            });
        }

        // 1. Récupérer les services actifs pour la date
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
                error: "Gare de départ ou d'arrivée introuvable",
                found: {
                    origin: stops.filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase())).map(s => s.stop_name),
                    destination: stops.filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase())).map(s => s.stop_name)
                }
            });
        }

        // 3. Rechercher les trajets directs
        const directTrains = await findDirectTrains(depIds, arrIds, serviceIds);

        // 4. Rechercher les trajets avec correspondances si demandé
        let transferTrains = [];
        if (parseInt(maxTransfers) >= 1) {
            transferTrains = await findTrainsWithTransfers(
                depIds, 
                arrIds, 
                serviceIds, 
                parseInt(maxTransfers),
                parseInt(minTransferTime)
            );
        }

        // 5. Dédupliquer : garder le meilleur trajet par heure de départ
        const allJourneys = [
            ...directTrains.map(t => ({ ...t, type: 'direct', transfers: 0 })),
            ...transferTrains
        ];

        // Grouper par heure de départ (arrondie à 5 min) + gare de départ
        const journeyMap = new Map();
        
        allJourneys.forEach(journey => {
            // Créer une clé basée sur l'heure de départ (arrondie) et la gare
            const depTime = journey.departure_time;
            const [hours, minutes] = depTime.split(':').map(Number);
            const roundedMinutes = Math.floor(minutes / 5) * 5; // Arrondir à 5 min
            const key = `${journey.departure_station}-${hours}:${roundedMinutes.toString().padStart(2, '0')}`;
            
            const existing = journeyMap.get(key);
            
            if (!existing) {
                // Pas de trajet existant, on l'ajoute
                journeyMap.set(key, journey);
            } else {
                // Comparer : on garde le plus rapide OU le direct
                const existingDuration = parseDuration(existing.duration);
                const currentDuration = parseDuration(journey.duration);
                
                // Priorité : 1. Direct 2. Plus rapide
                if (journey.type === 'direct' && existing.type !== 'direct') {
                    journeyMap.set(key, journey);
                } else if (existing.type === 'direct' && journey.type !== 'direct') {
                    // Garder l'existant (direct)
                } else if (currentDuration < existingDuration) {
                    journeyMap.set(key, journey);
                }
            }
        });

        // Convertir en tableau et trier
        const uniqueJourneys = Array.from(journeyMap.values())
            .sort((a, b) => a.departure_time.localeCompare(b.departure_time));

        res.json({
            success: true,
            count: uniqueJourneys.length,
            date: date,
            from: stops.find(s => depIds.includes(s.stop_id))?.stop_name,
            to: stops.find(s => arrIds.includes(s.stop_id))?.stop_name,
            summary: {
                direct: uniqueJourneys.filter(j => j.type === 'direct').length,
                withTransfers: uniqueJourneys.filter(j => j.type === 'with_transfer').length,
                total: uniqueJourneys.length
            },
            trains: uniqueJourneys
        });

    } catch (error) {
        console.error('Erreur recherche:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

/**
 * Parse une durée "3h45" en minutes
 */
function parseDuration(durationStr) {
    try {
        const match = durationStr.match(/(\d+)h(\d+)/);
        if (!match) return 9999;
        return parseInt(match[1]) * 60 + parseInt(match[2]);
    } catch (e) {
        return 9999;
    }
}

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
 * Recherche les trajets avec correspondances (APPROCHE THÉORIE DES GRAPHES)
 * Utilise l'intersection S(A) ∩ E(B) pour trouver les gares de correspondance
 */
async function findTrainsWithTransfers(originIds, destIds, serviceIds, maxTransfers, minTransferTime) {
    if (maxTransfers < 1) return [];

    const journeys = [];

    try {
        // ===================================================================
        // ÉTAPE 1 : PARALLÉLISATION - Deux requêtes simultanées
        // ===================================================================
        
        // Q1: S(A) - Ensemble des gares accessibles depuis A
        // Récupère tous les trains partant de l'origine avec TOUS leurs arrêts
        const q1Promise = supabase
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
            .order('departure_time', { ascending: true })
            .limit(50); // Limiter le nombre de trains de départ

        // Q2: E(B) - Ensemble des gares qui permettent d'arriver à B
        // Récupère tous les trains arrivant à la destination avec TOUS leurs arrêts
        const q2Promise = supabase
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

        // Exécution parallèle des deux requêtes
        const [{ data: trainsFromOrigin, error: e1 }, { data: trainsToDestination, error: e2 }] = 
            await Promise.all([q1Promise, q2Promise]);

        if (e1 || e2) {
            console.error('Erreur lors des requêtes parallèles:', e1 || e2);
            return [];
        }

        if (!trainsFromOrigin?.length || !trainsToDestination?.length) {
            return [];
        }

        // ===================================================================
        // ÉTAPE 2 : CONSTRUCTION DES ENSEMBLES S(A) et E(B)
        // ===================================================================

        // Récupérer tous les arrêts des trains partant de A
        const train1TripIds = [...new Set(trainsFromOrigin.map(t => t.trip_id))];
        
        const { data: allStopsFromA, error: e3 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time, departure_time, stops(stop_id, stop_name)')
            .in('trip_id', train1TripIds)
            .order('trip_id', { ascending: true })
            .order('stop_sequence', { ascending: true });

        if (e3) {
            console.error('Erreur récupération arrêts depuis A:', e3);
            return [];
        }

        // Récupérer tous les arrêts des trains allant vers B
        const train2TripIds = [...new Set(trainsToDestination.map(t => t.trip_id))];
        
        const { data: allStopsToB, error: e4 } = await supabase
            .from('stop_times')
            .select('trip_id, stop_id, stop_sequence, arrival_time, departure_time, stops(stop_id, stop_name)')
            .in('trip_id', train2TripIds)
            .order('trip_id', { ascending: true })
            .order('stop_sequence', { ascending: true });

        if (e4) {
            console.error('Erreur récupération arrêts vers B:', e4);
            return [];
        }

        // Grouper par trip_id
        const stopsFromAByTrip = groupByTripId(allStopsFromA);
        const stopsToBByTrip = groupByTripId(allStopsToB);

        // ===================================================================
        // ÉTAPE 3 : CALCUL DE L'INTERSECTION S(A) ∩ E(B)
        // ===================================================================

        // Construire S(A): Map de stop_id -> [trips qui y passent depuis A]
        const setA = new Map(); // stop_id -> [{trip_id, arrival_time, departure_time, stop_sequence, trip_info}]
        
        trainsFromOrigin.forEach(departureStop => {
            const tripStops = stopsFromAByTrip[departureStop.trip_id];
            if (!tripStops) return;

            const originStop = tripStops.find(s => originIds.includes(s.stop_id));
            if (!originStop) return;

            // Pour chaque arrêt après le départ
            tripStops.forEach(stop => {
                if (stop.stop_sequence <= originStop.stop_sequence) return;
                if (destIds.includes(stop.stop_id)) return; // Exclure la destination finale

                if (!setA.has(stop.stop_id)) {
                    setA.set(stop.stop_id, []);
                }

                setA.get(stop.stop_id).push({
                    trip_id: departureStop.trip_id,
                    arrival_time: stop.arrival_time,
                    departure_time_from_origin: originStop.departure_time,
                    arrival_time_at_transfer: stop.arrival_time,
                    stop_sequence: stop.stop_sequence,
                    origin_stop: originStop.stops.stop_name,
                    transfer_stop: stop.stops.stop_name,
                    trip_info: departureStop.trips
                });
            });
        });

        // Construire E(B): Map de stop_id -> [trips qui en partent vers B]
        const setB = new Map(); // stop_id -> [{trip_id, departure_time, arrival_time, stop_sequence, trip_info}]
        
        trainsToDestination.forEach(arrivalStop => {
            const tripStops = stopsToBByTrip[arrivalStop.trip_id];
            if (!tripStops) return;

            const destinationStop = tripStops.find(s => destIds.includes(s.stop_id));
            if (!destinationStop) return;

            // Pour chaque arrêt avant l'arrivée
            tripStops.forEach(stop => {
                if (stop.stop_sequence >= destinationStop.stop_sequence) return;
                if (originIds.includes(stop.stop_id)) return; // Exclure l'origine

                if (!setB.has(stop.stop_id)) {
                    setB.set(stop.stop_id, []);
                }

                setB.get(stop.stop_id).push({
                    trip_id: arrivalStop.trip_id,
                    departure_time: stop.departure_time,
                    arrival_time_at_destination: destinationStop.arrival_time,
                    stop_sequence: stop.stop_sequence,
                    transfer_stop: stop.stops.stop_name,
                    destination_stop: destinationStop.stops.stop_name,
                    trip_info: arrivalStop.trips
                });
            });
        });

        // Calculer C ∈ S(A) ∩ E(B)
        const commonStops = [...setA.keys()].filter(stopId => setB.has(stopId));

        console.log(`🔍 Intersection trouvée: ${commonStops.length} gares communes`);

        // ===================================================================
        // ÉTAPE 4 : CONTRAINTE TEMPORELLE - Vérification T_arrivée + M ≤ T_départ
        // ===================================================================

        for (const transferStopId of commonStops) {
            const trainsFromA = setA.get(transferStopId);
            const trainsToB = setB.get(transferStopId);

            // Pour chaque combinaison de trains
            for (const train1 of trainsFromA) {
                for (const train2 of trainsToB) {
                    // Vérifier que ce ne sont pas le même train
                    if (train1.trip_id === train2.trip_id) continue;

                    // CONTRAINTE TEMPORELLE CRITIQUE
                    // T_arrivée_train1(C) + M ≤ T_départ_train2(C)
                    const transferTimeMinutes = calculateTransferTimeMinutes(
                        train1.arrival_time_at_transfer,
                        train2.departure_time
                    );

                    // Vérifier les contraintes
                    if (transferTimeMinutes < minTransferTime) continue; // Trop court
                    if (transferTimeMinutes > 360) continue; // Trop long (>6h)

                    // ✅ Correspondance valide trouvée !
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

        console.log(`✅ ${journeys.length} correspondances valides trouvées`);
        return journeys;

    } catch (error) {
        console.error('Erreur dans findTrainsWithTransfers:', error);
        return [];
    }
}

/**
 * Grouper les arrêts par trip_id
 */
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

// Route de debug pour vérifier les dates
app.get('/api/debug/dates', async (req, res) => {
    try {
        const { date } = req.query;

        // 1. Voir quelques exemples de dates
        const { data: sampleDates } = await supabase
            .from('calendar_dates')
            .select('date, exception_type, service_id')
            .limit(10);

        // 2. Si une date est fournie, chercher avec différents formats
        let searchResults = {};
        if (date) {
            // Tester plusieurs formats
            const formats = {
                'original': date,
                'sans_tirets': date.replace(/-/g, ''),
                'avec_tirets': date.includes('-') ? date : `${date.slice(0,4)}-${date.slice(4,6)}-${date.slice(6,8)}`
            };

            for (const [formatName, testDate] of Object.entries(formats)) {
                const { data } = await supabase
                    .from('calendar_dates')
                    .select('date, exception_type, service_id')
                    .eq('date', testDate)
                    .limit(5);
                searchResults[formatName] = data;
            }
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
            hint: "Vérifiez le format des dates dans sampleDates"
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
            'GET /api/trains?from=Paris&to=Nantes&date=2026-07-10&maxTransfers=1&minTransferTime=30',
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
    console.log(`🔄 Correspondances activées !`);
});