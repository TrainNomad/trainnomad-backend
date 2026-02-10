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

        // 1. Récupérer les services actifs pour la date
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
                message: "Aucun service trouvé pour cette date",
                hint: `Format de date testé: ${date}`
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
 * Recherche les trajets avec correspondances (VERSION OPTIMISÉE)
 */
async function findTrainsWithTransfers(originIds, destIds, serviceIds, maxTransfers, minTransferTime) {
    if (maxTransfers < 1) return [];

    const journeys = [];

    try {
        // ÉTAPE 1: Récupérer uniquement les trains qui partent de l'origine
        const { data: firstLegStops, error: e1 } = await supabase
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
            .limit(50); // Limiter à 50 trains de départ pour éviter le timeout

        if (e1) throw e1;
        if (!firstLegStops || firstLegStops.length === 0) return [];

        // ÉTAPE 2: Pour chaque train de départ, récupérer TOUS ses arrêts
        const firstLegTripIds = [...new Set(firstLegStops.map(s => s.trip_id))];
        
        const { data: allFirstLegStops, error: e2 } = await supabase
            .from('stop_times')
            .select(`
                trip_id,
                arrival_time,
                departure_time,
                stop_sequence,
                stop_id,
                stops(stop_id, stop_name)
            `)
            .in('trip_id', firstLegTripIds)
            .order('trip_id', { ascending: true })
            .order('stop_sequence', { ascending: true });

        if (e2) throw e2;

        // Grouper par trip_id
        const firstLegTrips = {};
        allFirstLegStops.forEach(stop => {
            if (!firstLegTrips[stop.trip_id]) {
                firstLegTrips[stop.trip_id] = [];
            }
            firstLegTrips[stop.trip_id].push(stop);
        });

        // ÉTAPE 3: Pour chaque train de départ, identifier les gares de correspondance possibles
        for (const firstLegStop of firstLegStops) {
            const tripStops = firstLegTrips[firstLegStop.trip_id];
            if (!tripStops) continue;

            const departureStop = tripStops.find(s => originIds.includes(s.stop_id));
            if (!departureStop) continue;

            // Récupérer les métadonnées du train
            const tripInfo = firstLegStop.trips;

            // Trouver les gares potentielles de correspondance (après le départ, avant la destination)
            const potentialTransferStops = tripStops.filter(stop => 
                stop.stop_sequence > departureStop.stop_sequence &&
                !destIds.includes(stop.stop_id)
            );

            // Limiter à 10 gares de correspondance max par train
            const transferStops = potentialTransferStops.slice(0, 10);

            // ÉTAPE 4: Pour chaque gare de correspondance, chercher des trains vers la destination
            for (const transferStop of transferStops) {
                const arrivalAtTransfer = transferStop.arrival_time;
                const transferStopId = transferStop.stop_id;

                // Calculer l'heure minimum de départ du 2ème train
                const minDepartureTime = addMinutes(arrivalAtTransfer, minTransferTime);
                const maxDepartureTime = addMinutes(arrivalAtTransfer, 360); // Max 6h d'attente

                // Chercher les trains partant de cette gare vers la destination
                const { data: secondLegCandidates, error: e3 } = await supabase
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
                    .eq('stop_id', transferStopId)
                    .in('trips.service_id', serviceIds)
                    .gte('departure_time', minDepartureTime)
                    .lte('departure_time', maxDepartureTime)
                    .neq('trip_id', firstLegStop.trip_id) // Pas le même train
                    .limit(20);

                if (e3 || !secondLegCandidates) continue;

                // Pour chaque train candidat, vérifier s'il va à la destination
                const secondLegTripIds = [...new Set(secondLegCandidates.map(s => s.trip_id))];
                
                const { data: secondLegToDestination, error: e4 } = await supabase
                    .from('stop_times')
                    .select(`
                        trip_id,
                        arrival_time,
                        departure_time,
                        stop_sequence,
                        stop_id,
                        stops(stop_id, stop_name)
                    `)
                    .in('trip_id', secondLegTripIds)
                    .in('stop_id', destIds);

                if (e4 || !secondLegToDestination) continue;

                // Matcher les trains qui passent par la correspondance ET la destination
                for (const secondLegStart of secondLegCandidates) {
                    const destStop = secondLegToDestination.find(d => 
                        d.trip_id === secondLegStart.trip_id &&
                        d.stop_sequence > secondLegStart.stop_sequence
                    );

                    if (!destStop) continue;

                    const transferTimeMinutes = calculateTransferTimeMinutes(
                        arrivalAtTransfer,
                        secondLegStart.departure_time
                    );

                    // Ajouter le trajet avec correspondance
                    journeys.push({
                        type: 'with_transfer',
                        transfers: 1,
                        departure_station: departureStop.stops.stop_name,
                        arrival_station: destStop.stops.stop_name,
                        departure_time: departureStop.departure_time,
                        arrival_time: destStop.arrival_time,
                        duration: calculateDuration(departureStop.departure_time, destStop.arrival_time),
                        legs: [
                            {
                                train_number: tripInfo.trip_headsign || tripInfo.routes.route_short_name || 'N/A',
                                train_type: tripInfo.routes.route_long_name || "Train",
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
                                train_number: secondLegStart.trips.trip_headsign || secondLegStart.trips.routes.route_short_name || 'N/A',
                                train_type: secondLegStart.trips.routes.route_long_name || "Train",
                                departure_station: transferStop.stops.stop_name,
                                arrival_station: destStop.stops.stop_name,
                                departure_time: secondLegStart.departure_time,
                                arrival_time: destStop.arrival_time,
                                duration: calculateDuration(secondLegStart.departure_time, destStop.arrival_time)
                            }
                        ]
                    });
                }
            }
        }

        return journeys;

    } catch (error) {
        console.error('Erreur dans findTrainsWithTransfers:', error);
        return []; // Retourner un tableau vide en cas d'erreur plutôt que de crasher
    }
}

/**
 * Ajoute des minutes à un horaire format HH:MM:SS
 */
function addMinutes(timeString, minutes) {
    try {
        const [h, m, s] = timeString.split(':').map(Number);
        let totalMinutes = h * 60 + m + minutes;
        
        // Gérer le passage de minuit
        if (totalMinutes >= 24 * 60) {
            totalMinutes = totalMinutes % (24 * 60);
        }
        
        const newHours = Math.floor(totalMinutes / 60);
        const newMinutes = totalMinutes % 60;
        
        return `${newHours.toString().padStart(2, '0')}:${newMinutes.toString().padStart(2, '0')}:00`;
    } catch (e) {
        return timeString;
    }
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