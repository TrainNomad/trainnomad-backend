// services/trainService.js

function calculateDuration(dep, arr) {
    try {
        const [dh, dm] = dep.split(':').map(Number);
        const [ah, am] = arr.split(':').map(Number);
        let diff = (ah * 60 + am) - (dh * 60 + dm);
        if (diff < 0) diff += 1440; // Gère le passage à minuit
        return `${Math.floor(diff / 60)}h${(diff % 60).toString().padStart(2, '0')}`;
    } catch (e) { return 'N/A'; }
}

function getMinutes(timeStr) {
    const [h, m] = timeStr.split(':').map(Number);
    return h * 60 + m;
}

module.exports = { calculateDuration, getMinutes };