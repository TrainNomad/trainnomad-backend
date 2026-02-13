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

// ==================== CONSTANTES MATHÉMATIQUES ====================
const TRANSFER_CONSTRAINTS = {
    t_min: 5,      // Temps minimum de correspondance (minutes)
    t_max: 360      // Temps maximum d'attente (6 heures)
};

// ==================== UTILITAIRES MATHÉMATIQUES ====================

/**
 * Convertit un horaire HH:MM:SS en minutes depuis minuit
 * Utilisé pour les calculs de durée et de contraintes temporelles
 */
function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

/**
 * Calcule la durée entre deux horaires
 * Formule: Δt = T_arr - T_dep (en gérant le passage de minuit)
 */
function calculateDuration(T_dep, T_arr) {
    try {
        const depMinutes = timeToMinutes(T_dep);
        const arrMinutes = timeToMinutes(T_arr);
        
        let duration = arrMinutes - depMinutes;
        if (duration < 0) duration += 24 * 60; // Passage minuit
        
        const hours = Math.floor(duration / 60);
        const minutes = duration % 60;
        
        return `${hours}h${minutes.toString().padStart(2, '0')}`;
    } catch (e) {
        return 'N/A';
    }
}

/**
 * Vérifie la CONDITION B: Contrainte temporelle de correspondance
 * T_arr1 + t_min ≤ T_dep2
 */
function isValidTransferTime(T_arr1, T_dep2, t_min = TRANSFER_CONSTRAINTS.t_min) {
    const arr1Minutes = timeToMinutes(T_arr1);
    const dep2Minutes = timeToMinutes(T_dep2);
    
    let waitTime = dep2Minutes - arr1Minutes;
    if (waitTime < 0) waitTime += 24 * 60; // Passage minuit
    
    return waitTime;
}

/**
 * Vérifie la CONDITION C: Optimisation du temps d'attente
 * T_dep2 - T_arr1 ≤ t_max
 */
function isWithinMaxWaitTime(waitTimeMinutes, t_max = TRANSFER_CONSTRAINTS.t_max) {
    return waitTimeMinutes <= t_max;
}

// ==================== ROUTES ====================

app.get('/', (req, res) => {
    res.json({
        message: '✅ TrainNomad Backend - Version Mathématique',
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '6.0 - Formules Mathématiques de Correspondance',
        constraints: TRANSFER_CONSTRAINTS
    });
});

app.get('/health', async (req, res) => {
    try {
        const checks = {};
        const tables = ['stops', 'routes', 'trips', 'stop_times', 'calendar_dates'];
        
        for (const table of tables) {
            try {
                const { count } = await supabase.from(table).select('*', { count: 'exact', head: true });
                checks[table] = count;
            } catch (e) {
                checks[table] = `Error: ${e.message}`;
            }
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

// ==================== ROUTE PRINCIPALE ====================

app.get('/api/trains', async (req, res) => {
    try {
        const { 
            from, 
            to, 
            date, 
            startTime = "00:00:00",
            limit = 50,
            maxTransfers = 1,
            minTransferTime = TRANSFER_CONSTRAINTS.t_min,
            maxWaitTime = TRANSFER_CONSTRAINTS.t_max,
            includeTransfers = 'true'
        } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ 
                error: "Paramètres from, to et date requis"
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

        // 2. Trouver les gares G_A et G_B
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const G_A_ids = stops.filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase())).map(s => s.stop_id);
        const G_B_ids = stops.filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase())).map(s => s.stop_id);

        if (G_A_ids.length === 0 || G_B_ids.length === 0) {
            return res.json({
                success: false,
                error: "Gare introuvable"
            });
        }

        // 3. Rechercher les trajets directs
        const directTrains = await findDirectTrains(
            supabase,
            G_A_ids,
            G_B_ids,
            serviceIds,
            startTime
        );

        // 4. Rechercher les correspondances si demandé
        let transferTrains = [];
        if (includeTransfers === 'true' && parseInt(maxTransfers) >= 1) {
            transferTrains = await findTransferTrains(
                supabase,
                G_A_ids,
                G_B_ids,
                serviceIds,
                startTime,
                parseInt(minTransferTime),
                parseInt(maxWaitTime)
            );
        }

        // 5. Combiner et dédupliquer
        const allTrains = [...directTrains, ...transferTrains];
        const uniqueTrains = deduplicateTrains(allTrains);

        // 6. Trier et limiter
        const sortedTrains = uniqueTrains
            .sort((a, b) => a.departure_time.localeCompare(b.departure_time))
            .slice(0, parseInt(limit));

        // 7. Pagination
        const hasMore = uniqueTrains.length > parseInt(limit);
        const nextStartTime = hasMore ? sortedTrains[sortedTrains.length - 1].departure_time : null;

        console.log(`✅ ${sortedTrains.length} trajets trouvés (${directTrains.length} directs, ${transferTrains.length} correspondances)`);

        res.json({
            success: true,
            count: sortedTrains.length,
            date: date,
            from: stops.find(s => G_A_ids.includes(s.stop_id))?.stop_name,
            to: stops.find(s => G_B_ids.includes(s.stop_id))?.stop_name,
            pagination: {
                startTime: startTime,
                nextStartTime: nextStartTime,
                hasMore: hasMore,
                limit: parseInt(limit)
            },
            summary: {
                direct: sortedTrains.filter(t => t.type === 'direct').length,
                withTransfers: sortedTrains.filter(t => t.type === 'with_transfer').length
            },
            trains: sortedTrains
        });

    } catch (error) {
        console.error('❌ Erreur:', error);
        res.status(500).json({ 
            success: false, 
            error: error.message
        });
    }
});

// ==================== ALGORITHMES DE RECHERCHE ====================

/**
 * Recherche des trajets directs (pas de correspondance)
 */
async function findDirectTrains(supabase, G_A_ids, G_B_ids, serviceIds, startTime) {
    const { data, error } = await supabase
        .from('stop_times')
        .select(`
            trip_id,
            departure_time,
            stop_id,
            stops!inner ( stop_name ),
            trips!inner (
                trip_headsign,
                route_id,
                train_type, 
                service_id
            )
        `)
        .in('stop_id', G_A_ids)
        .in('trips.service_id', serviceIds)
        .gte('departure_time', startTime);

    if (error) throw error;

    const validTrains = [];
    for (const dep of data) {
        const { data: arrivalData } = await supabase
            .from('stop_times')
            .select(`
                arrival_time, 
                stop_id,
                stops!inner ( stop_name )
            `)
            .eq('trip_id', dep.trip_id)
            .in('stop_id', G_B_ids)
            .gt('arrival_time', dep.departure_time)
            .maybeSingle();

        if (arrivalData) {
            validTrains.push({
                type: 'direct',
                // trip_id: dep.trip_id,
                train_number: dep.trips.trip_headsign,
                train_type: dep.trips.train_type,
                departure_time: dep.departure_time,
                arrival_time: arrivalData.arrival_time,
                duration: calculateDuration(dep.departure_time, arrivalData.arrival_time), // <--- CONSERVÉ
                departure_station: dep.stops.stop_name, 
                arrival_station: arrivalData.stops.stop_name, 
                departure_stop_id: dep.stop_id,
                arrival_stop_id: arrivalData.stop_id
            });
        }
    }
    return validTrains;
}
/**
 * Recherche des trajets avec correspondances
 * APPLICATION DES FORMULES MATHÉMATIQUES:
 * 
 * A. CONDITION DE LIEU (Intersection):
 *    Gare d'arrivée du Train 1 = Gare de départ du Train 2 = G_C
 * 
 * B. CONDITION DE TEMPS (Battement):
 *    T_arr1 + t_min ≤ T_dep2
 * 
 * C. CONDITION D'OPTIMISATION:
 *    T_dep2 - T_arr1 ≤ t_max
 */
async function findTransferTrains(supabase, G_A_ids, G_B_ids, serviceIds, startTime, t_min, t_max) {
    // ÉTAPE 1: Récupérer les trains partant de G_A avec train_type
    const { data: train1Departures, error: e1 } = await supabase
        .from('stop_times')
        .select(`
            trip_id, departure_time, stop_sequence, stop_id,
            stops(stop_name),
            trips!inner ( trip_headsign, service_id, train_type ) -- train_type au lieu de route_long_name
        `)
        .in('stop_id', G_A_ids)
        .in('trips.service_id', serviceIds)
        .gte('departure_time', startTime);

    if (e1 || !train1Departures?.length) return [];

    // ÉTAPE 2: Récupérer les trains arrivant à G_B avec train_type
    const { data: train2Arrivals, error: e2 } = await supabase
        .from('stop_times')
        .select(`
            trip_id, arrival_time, stop_sequence, stop_id,
            stops(stop_name),
            trips!inner ( trip_headsign, service_id, train_type )
        `)
        .in('stop_id', G_B_ids)
        .in('trips.service_id', serviceIds);

    // ... (Étapes 3 et 4 : allStops1, allStops2 et groupByTripId restent identiques)

    const journeys = [];

    for (const train1Dep of train1Departures) {
        const allStopsOfTrain1 = stops1ByTrip[train1Dep.trip_id];
        if (!allStopsOfTrain1) continue;

        const G_A_stop = allStopsOfTrain1.find(s => G_A_ids.includes(s.stop_id));
        if (!G_A_stop) continue;

        const potentialTransfers = allStopsOfTrain1.filter(s => s.stop_sequence > G_A_stop.stop_sequence && !G_B_ids.includes(s.stop_id));

        for (const G_C_stop_train1 of potentialTransfers) {
            const G_C = G_C_stop_train1.stop_id;
            const T_arr1 = G_C_stop_train1.arrival_time;

            for (const train2Arr of train2Arrivals) {
                if (train2Arr.trip_id === train1Dep.trip_id) continue;

                const allStopsOfTrain2 = stops2ByTrip[train2Arr.trip_id];
                if (!allStopsOfTrain2) continue;

                const G_C_stop_train2 = allStopsOfTrain2.find(s => s.stop_id === G_C);
                const G_B_stop = allStopsOfTrain2.find(s => G_B_ids.includes(s.stop_id));

                if (!G_C_stop_train2 || !G_B_stop || G_C_stop_train2.stop_sequence >= G_B_stop.stop_sequence) continue;

                const T_dep2 = G_C_stop_train2.departure_time;
                const waitTime = isValidTransferTime(T_arr1, T_dep2, t_min);

                if (waitTime >= t_min && isWithinMaxWaitTime(waitTime, t_max)) {
                    
                    // ON RECONSTRUIT L'OBJET AVEC LES NOMS ET LES TYPES
                    journeys.push({
                        type: 'with_transfer',
                        departure_time: G_A_stop.departure_time,
                        arrival_time: G_B_stop.arrival_time,
                        duration: calculateDuration(G_A_stop.departure_time, G_B_stop.arrival_time),
                        departure_station: G_A_stop.stops.stop_name,
                        arrival_station: G_B_stop.stops.stop_name,
                        legs: [
                            {
                                train_number: train1Dep.trips.trip_headsign,
                                train_type: train1Dep.trips.train_type, // <--- ICI
                                departure_station: G_A_stop.stops.stop_name,
                                arrival_station: G_C_stop_train1.stops.stop_name,
                                departure_time: G_A_stop.departure_time,
                                arrival_time: T_arr1,
                                duration: calculateDuration(G_A_stop.departure_time, T_arr1)
                            },
                            {
                                transfer_time: `${waitTime} min`,
                                station: G_C_stop_train1.stops.stop_name
                            },
                            {
                                train_number: train2Arr.trips.trip_headsign,
                                train_type: train2Arr.trips.train_type, // <--- ET ICI
                                departure_station: G_C_stop_train2.stops.stop_name,
                                arrival_station: G_B_stop.stops.stop_name,
                                departure_time: T_dep2,
                                arrival_time: G_B_stop.arrival_time,
                                duration: calculateDuration(T_dep2, G_B_stop.arrival_time)
                            }
                        ]
                    });
                }
            }
        }
    }
    return journeys;
}

// ==================== FONCTIONS AUXILIAIRES ====================

function groupByTripId(stops) {
    const grouped = {};
    if (!stops) return grouped;
    
    stops.forEach(stop => {
        if (!grouped[stop.trip_id]) {
            grouped[stop.trip_id] = [];
        }
        grouped[stop.trip_id].push(stop);
    });
    return grouped;
}

/**
 * Déduplique les trajets en gardant le meilleur par créneau de 5 minutes
 */
function deduplicateTrains(trains) {
    const trainMap = new Map();
    
    trains.forEach(train => {
        const depTime = train.departure_time;
        const [hours, minutes] = depTime.split(':').map(Number);
        const roundedMinutes = Math.floor(minutes / 5) * 5;
        const key = `${train.departure_station}-${hours}:${roundedMinutes.toString().padStart(2, '0')}`;
        
        const existing = trainMap.get(key);
        
        if (!existing) {
            trainMap.set(key, train);
        } else {
            // Priorité: 1. Direct, 2. Plus rapide
            const existingDuration = timeToMinutes(existing.duration.replace('h', ':'));
            const currentDuration = timeToMinutes(train.duration.replace('h', ':'));
            
            if (train.type === 'direct' && existing.type !== 'direct') {
                trainMap.set(key, train);
            } else if (existing.type === 'direct' && train.type !== 'direct') {
                // Garder l'existant
            } else if (currentDuration < existingDuration) {
                trainMap.set(key, train);
            }
        }
    });
    
    return Array.from(trainMap.values());
}

// ==================== AUTRES ROUTES ====================

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

app.use((req, res) => {
    res.status(404).json({
        success: false,
        error: 'Route non trouvée',
        availableRoutes: [
            'GET /',
            'GET /health',
            'GET /api/available-dates',
            'GET /api/trains?from=Paris&to=Marseille&date=2026-07-10&startTime=08:00&limit=10',
            'GET /api/stations?search=Paris'
        ]
    });
});

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
    console.log(`🚀 Serveur démarré sur le port ${PORT}`);
    console.log(`📐 Formules mathématiques activées:`);
    console.log(`   A. Condition de lieu: G_C ∈ S(Train1) ∩ E(Train2)`);
    console.log(`   B. Condition de temps: T_arr1 + t_min ≤ T_dep2`);
    console.log(`   C. Condition d'optimisation: T_dep2 - T_arr1 ≤ t_max`);
    console.log(`   t_min = ${TRANSFER_CONSTRAINTS.t_min} min`);
    console.log(`   t_max = ${TRANSFER_CONSTRAINTS.t_max} min`);
});