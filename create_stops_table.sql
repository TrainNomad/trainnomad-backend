-- Script SQL pour créer la table stops dans Supabase
-- À exécuter dans le SQL Editor de Supabase

-- Supprimer la table si elle existe déjà (optionnel)
-- DROP TABLE IF EXISTS stops;

-- Créer la table stops
CREATE TABLE stops (
  id BIGSERIAL PRIMARY KEY,
  stop_id TEXT UNIQUE NOT NULL,
  stop_name TEXT,
  stop_desc TEXT,
  stop_lat DOUBLE PRECISION,
  stop_lon DOUBLE PRECISION,
  zone_id TEXT,
  stop_url TEXT,
  location_type INTEGER,
  parent_station TEXT,
  created_at TIMESTAMP WITH TIME ZONE DEFAULT NOW()
);

-- Créer des index pour améliorer les performances
CREATE INDEX idx_stops_stop_id ON stops(stop_id);
CREATE INDEX idx_stops_stop_name ON stops(stop_name);
CREATE INDEX idx_stops_parent_station ON stops(parent_station);
CREATE INDEX idx_stops_location_type ON stops(location_type);

-- Activer Row Level Security
ALTER TABLE stops ENABLE ROW LEVEL SECURITY;

-- Créer une policy pour permettre la lecture publique
CREATE POLICY "Permettre lecture publique des stops" ON stops
  FOR SELECT USING (true);

-- Créer une policy pour permettre l'insertion (optionnel, pour votre script d'import)
CREATE POLICY "Permettre insertion des stops" ON stops
  FOR INSERT WITH CHECK (true);

-- Créer une policy pour permettre la mise à jour (optionnel)
CREATE POLICY "Permettre mise à jour des stops" ON stops
  FOR UPDATE USING (true);

COMMENT ON TABLE stops IS 'Table des arrêts de transport (GTFS stops.txt)';
COMMENT ON COLUMN stops.stop_id IS 'Identifiant unique de l''arrêt (ex: StopArea:OCE71043075)';
COMMENT ON COLUMN stops.stop_name IS 'Nom de l''arrêt (ex: FIGUERES-VILAFANT)';
COMMENT ON COLUMN stops.stop_lat IS 'Latitude de l''arrêt';
COMMENT ON COLUMN stops.stop_lon IS 'Longitude de l''arrêt';
COMMENT ON COLUMN stops.location_type IS '0=arrêt, 1=station/zone';
COMMENT ON COLUMN stops.parent_station IS 'ID de la station parente (pour les arrêts de type 0)';
