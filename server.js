require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { createClient } = require('@supabase/supabase-js');

const app = express();

app.use(cors());
app.use(express.json());

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
            minTransferTime = 5,
            maxWaitTime = 360
        } = req.query;

        if (!from || !to || !date) {
            return res.status(400).json({ error: "Paramètres from, to et date requis" });
        }

        console.log(`🔍 Calcul mathématique : ${from} → ${to} le ${date}`);

        // 1. Identification des IDs des gares (Indispensable pour la fonction SQL)
        const { data: stops } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        const G_A_ids = stops
            .filter(s => s.stop_name.toLowerCase().includes(from.toLowerCase()))
            .map(s => s.stop_id);
        const G_B_ids = stops
            .filter(s => s.stop_name.toLowerCase().includes(to.toLowerCase()))
            .map(s => s.stop_id);

        if (G_A_ids.length === 0 || G_B_ids.length === 0) {
            return res.json({ success: false, error: "Gare de départ ou d'arrivée introuvable" });
        }

        // 2. APPEL DE LA FORMULE (RPC)
        // On envoie les données brutes à PostgreSQL qui traite les millions de lignes
        const { data: results, error: rpcError } = await supabase.rpc('find_optimized_trains', {
            p_from_ids: G_A_ids,
            p_to_ids: G_B_ids,
            p_date: date,
            p_start_time: startTime,
            p_t_min: parseInt(minTransferTime),
            p_t_max: parseInt(maxWaitTime)
        });

        if (rpcError) throw rpcError;

        // 3. Formatage pour le front-end
        const formattedTrains = results.map(t => ({
            type: t.journey_type,
            departure_station: t.departure_station,
            arrival_station: t.arrival_station,
            departure_time: t.departure_time,
            arrival_time: t.arrival_time,
            // Conversion mathématique de la durée stockée en minutes
            duration: `${Math.floor(t.total_duration_min / 60)}h${(t.total_duration_min % 60).toString().padStart(2, '0')}`,
            details: {
                steps: t.stops_list, // Liste des gares de passage
                train_names: t.trips_list // Noms des trains empruntés
            }
        }));

        // 4. Déduplication finale (Optionnel mais recommandé)
        const finalResults = deduplicateTrains(formattedTrains).slice(0, parseInt(limit));

        console.log(`✅ ${finalResults.length} trajets calculés avec succès.`);

        res.json({
            success: true,
            count: finalResults.length,
            from: from,
            to: to,
            date: date,
            trains: finalResults
        });

    } catch (error) {
        console.error('❌ Erreur Route Trains:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// // 3. Appel de la formule mathématique dans Supabase
// const { data: results, error: rpcError } = await supabase.rpc('find_optimized_trains', {
//     p_from_ids: G_A_ids,
//     p_to_ids: G_B_ids,
//     p_date: date,
//     p_start_time: startTime,
//     p_t_min: parseInt(minTransferTime),
//     p_t_max: parseInt(maxWaitTime)
// });

// if (rpcError) throw rpcError;

// // 4. Formatage simple pour le front-end
// const formattedTrains = results.map(t => ({
//     type: t.journey_type,
//     departure_station: t.departure_station,
//     arrival_station: t.arrival_station,
//     departure_time: t.departure_time,
//     arrival_time: t.arrival_time,
//     duration: `${Math.floor(t.total_duration_min / 60)}h${(t.total_duration_min % 60).toString().padStart(2, '0')}`,
//     details: {
//         stops: t.stops_list,
//         trains: t.trips_list
//     }
// }));

// res.json({ success: true, count: formattedTrains.length, trains: formattedTrains });

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
            'GET /api/trains?from=Paris&to=Marseille&date=2026-07-10&startTime=08:00&limit=50',
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