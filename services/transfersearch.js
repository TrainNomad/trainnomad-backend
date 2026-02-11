// services/transferSearch.js
const { calculateDuration, getMinutes } = require('trainService');

async function findTransferTrains(supabase, { originIds, destIds, serviceIds, startTime, minTransferTime }) {
    // 1. Trains partant de l'origine
    const { data: depTrains } = await supabase
        .from('stop_times')
        .select('trip_id, departure_time, stop_id, stop_sequence, stops(stop_name), trips!inner(trip_headsign, routes(route_long_name, route_short_name))')
        .in('stop_id', originIds)
        .in('trips.service_id', serviceIds)
        .gte('departure_time', startTime)
        .limit(100);

    if (!depTrains || depTrains.length === 0) return [];

    // 2. Trains arrivant à destination
    const { data: arrTrains } = await supabase
        .from('stop_times')
        .select('trip_id, arrival_time, stop_id, stop_sequence, stops(stop_name), trips!inner(trip_headsign, routes(route_long_name, route_short_name))')
        .in('stop_id', destIds)
        .in('trips.service_id', serviceIds);

    // 3. Récupérer tous les arrêts des trains de départ pour trouver les points de connexion
    const tripIds = depTrains.map(t => t.trip_id);
    const { data: connections } = await supabase
        .from('stop_times')
        .select('trip_id, stop_id, arrival_time, stop_sequence, stops(stop_name)')
        .in('trip_id', tripIds);

    const journeys = [];

    // Algorithme de croisement
    for (const start of depTrains) {
        const possibleTransfers = connections.filter(c => c.trip_id === start.trip_id && c.stop_sequence > start.stop_sequence);
        
        for (const transferPoint of possibleTransfers) {
            // Chercher si un train de destination part de ce point de transfert
            const secondLegs = arrTrains.filter(dest => 
                dest.stop_id === transferPoint.stop_id && 
                getMinutes(dest.arrival_time) > getMinutes(transferPoint.arrival_time) + minTransferTime
            );

            for (const end of secondLegs) {
                // Pour simplifier, on récupère les infos de la deuxième jambe (leg)
                // Dans une version réelle, il faudrait une requête SQL de plus pour les infos du trip du 2ème train
                journeys.push({
                    type: 'with_transfer',
                    departure_time: start.departure_time,
                    arrival_time: end.arrival_time,
                    departure_station: start.stops.stop_name,
                    arrival_station: end.stops.stop_name,
                    duration: calculateDuration(start.departure_time, end.arrival_time),
                    legs: [
                        { departure_station: start.stops.stop_name, arrival_station: transferPoint.stops.stop_name, departure_time: start.departure_time, arrival_time: transferPoint.arrival_time },
                        { transfer_time: `${getMinutes(end.arrival_time) - getMinutes(transferPoint.arrival_time)} min`, station: transferPoint.stops.stop_name },
                        { departure_station: transferPoint.stops.stop_name, arrival_station: end.stops.stop_name, departure_time: "...", arrival_time: end.arrival_time }
                    ]
                });
            }
        }
    }
    return journeys;
}

module.exports = { findTransferTrains };