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
    t_min: 5,
    t_max: 360
};

// ==================== UTILITAIRES ====================

function timeToMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

function calculateDuration(T_dep, T_arr) {
    try {
        const depMinutes = timeToMinutes(T_dep);
        const arrMinutes = timeToMinutes(T_arr);
        let duration = arrMinutes - depMinutes;
        if (duration < 0) duration += 24 * 60;
        const hours = Math.floor(duration / 60);
        const minutes = duration % 60;
        return `${hours}h${minutes.toString().padStart(2, '0')}`;
    } catch (e) {
        return 'N/A';
    }
}

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

// ==================== ROUTES ====================

app.get('/', (req, res) => {
    res.json({
        message: '✅ TrainNomad Backend',
        status: 'OK',
        timestamp: new Date().toISOString(),
        version: '7.0',
        constraints: TRANSFER_CONSTRAINTS
    });
});

app.get('/health', async (req, res) => {
    try {
        const checks = {};
        const tables = ['stops', 'routes', 'trips', 'stop_times', 'calendar_dates'];

        for (const table of tables) {
            try {
                const { count } = await supabase
                    .from(table)
                    .select('*', { count: 'exact', head: true });
                checks[table] = count;
            } catch (e) {
                checks[table] = `Error: ${e.message}`;
            }
        }

        res.json({ status: 'healthy', database: 'connected', tables: checks });
    } catch (error) {
        res.status(500).json({ status: 'unhealthy', database: 'error', error: error.message });
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

        console.log(`🔍 Recherche : ${from} → ${to} le ${date}`);

        // 1. Récupération des IDs de gares
        const { data: stopsData, error: stopsError } = await supabase
            .from('stops')
            .select('stop_id, stop_name')
            .or(`stop_name.ilike.%${from}%,stop_name.ilike.%${to}%`);

        // ✅ Protection contre null/undefined
        if (stopsError) {
            console.error('❌ Erreur stops:', stopsError);
            return res.status(500).json({ success: false, error: `Erreur base de données: ${stopsError.message}` });
        }

        if (!stopsData || !Array.isArray(stopsData)) {
            console.error('❌ stopsData est null ou undefined');
            return res.status(500).json({ success: false, error: "Impossible de récupérer les gares" });
        }

        if (stopsData.length === 0) {
            return res.json({ success: false, error: "Aucune gare trouvée pour ces noms" });
        }

        const G_A_ids = stopsData
            .filter(s => s.stop_name && s.stop_name.toLowerCase().includes(from.toLowerCase()))
            .map(s => String(s.stop_id));

        const G_B_ids = stopsData
            .filter(s => s.stop_name && s.stop_name.toLowerCase().includes(to.toLowerCase()))
            .map(s => String(s.stop_id));

        console.log(`📍 Gares départ trouvées: ${G_A_ids.length} | Gares arrivée: ${G_B_ids.length}`);

        if (G_A_ids.length === 0) {
            return res.json({ success: false, error: `Gare de départ introuvable: "${from}"` });
        }
        if (G_B_ids.length === 0) {
            return res.json({ success: false, error: `Gare d'arrivée introuvable: "${to}"` });
        }

        // 2. Appel RPC
        const { data: results, error: rpcError } = await supabase.rpc('find_optimized_trains', {
            p_from_ids: G_A_ids,
            p_to_ids: G_B_ids,
            p_date: date,
            p_start_time: startTime,
            p_t_min: parseInt(minTransferTime),
            p_t_max: parseInt(maxWaitTime)
        });

        if (rpcError) {
            console.error('❌ Erreur RPC:', rpcError);
            throw rpcError;
        }

        // ✅ Protection contre results null
        if (!results || !Array.isArray(results)) {
            return res.json({ success: true, count: 0, from, to, date, trains: [] });
        }

        // 3. Formatage
        const formattedTrains = results.map(t => ({
            type: t.journey_type,
            departure_station: t.departure_station,
            arrival_station: t.arrival_station,
            departure_time: t.departure_time,
            arrival_time: t.arrival_time,
            duration: `${Math.floor(t.total_duration_min / 60)}h${(t.total_duration_min % 60).toString().padStart(2, '0')}`,
            details: {
                steps: t.stops_list,
                train_names: t.trips_list
            }
        }));

        // 4. Déduplication
        const finalResults = deduplicateTrains(formattedTrains).slice(0, parseInt(limit));

        console.log(`✅ ${finalResults.length} trajets trouvés`);

        res.json({
            success: true,
            count: finalResults.length,
            from,
            to,
            date,
            trains: finalResults
        });

    } catch (error) {
        console.error('❌ Erreur Route Trains:', error);
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== AUTRES ROUTES ====================

app.get('/api/available-dates', async (req, res) => {
    try {
        const { data: dates, error } = await supabase
            .from('calendar_dates')
            .select('date')
            .eq('exception_type', 1)
            .order('date', { ascending: true });

        if (error) throw error;

        // ✅ Protection contre null
        if (!dates || !Array.isArray(dates)) {
            return res.json({ success: true, dateRange: null, byMonth: {}, sampleDates: [] });
        }

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
            dateRange: { first: minDate, last: maxDate, totalDays: uniqueDates.length },
            byMonth,
            sampleDates: uniqueDates.slice(0, 10),
            message: `Données disponibles du ${minDate} au ${maxDate}`
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
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
            count: data ? data.length : 0,
            stations: data || []
        });

    } catch (error) {
        res.status(500).json({ success: false, error: error.message });
    }
});

// ==================== 404 & ERROR HANDLERS ====================

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
    console.log(`   t_min = ${TRANSFER_CONSTRAINTS.t_min} min`);
    console.log(`   t_max = ${TRANSFER_CONSTRAINTS.t_max} min`);
});