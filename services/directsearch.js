// services/directSearch.js
const { calculateDuration } = require('trainService');

async function findDirectTrains(supabase, { originIds, destIds, serviceIds, startTime, limit }) {
    const { data: results, error } = await supabase
        .from('stop_times')
        .select(`
            trip_id, arrival_time, departure_time, stop_sequence, stop_id,
            stops(stop_name),
            trips!inner (
                trip_headsign, route_id, service_id,
                routes(route_short_name, route_long_name)
            )
        `)
        .in('stop_id', [...originIds, ...destIds])
        .in('trips.service_id', serviceIds)
        .gte('departure_time', startTime)
        .order('departure_time', { ascending: true })
        .limit(300); // On augmente encore pour être sûr de ne rien rater

    if (error) throw error;

    const tripsMap = {};
    results.forEach(row => {
        if (!tripsMap[row.trip_id]) tripsMap[row.trip_id] = { dep: null, arr: null };
        if (originIds.includes(row.stop_id)) {
            if (!tripsMap[row.trip_id].dep || row.stop_sequence < tripsMap[row.trip_id].dep.stop_sequence) tripsMap[row.trip_id].dep = row;
        } else if (destIds.includes(row.stop_id)) {
            if (!tripsMap[row.trip_id].arr || row.stop_sequence > tripsMap[row.trip_id].arr.stop_sequence) tripsMap[row.trip_id].arr = row;
        }
    });

    return Object.values(tripsMap)
        .filter(t => t.dep && t.arr && t.dep.stop_sequence < t.arr.stop_sequence)
        .map(t => ({
            type: 'direct',
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

module.exports = { findDirectTrains };