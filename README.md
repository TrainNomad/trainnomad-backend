# TrainNomad Backend API

Backend Node.js simple pour l'application TrainNomad.

## 🚀 Démarrage local

### Installation
```bash
npm install
npm start
```

Le serveur démarre sur `http://localhost:3000`

## 📡 Routes disponibles

### 1. Test de santé
```
GET /
GET /health
```

### 2. Liste tous les trajets
```
GET /api/trajets
```

### 3. Rechercher des billets
```
GET /api/billets?depart=Angers&arrivee=Nantes
```
Paramètres :
- `depart` (requis) : Gare de départ
- `arrivee` (requis) : Gare d'arrivée
- `date` (optionnel) : Date du trajet

### 4. Trajet spécifique
```
GET /api/trajets/:id
```

## 📦 Déploiement sur Render

### Étape 1 : Créer le service
1. Aller sur https://render.com
2. Cliquer sur **"New +" → "Web Service"**
3. Connecter votre dépôt GitHub

### Étape 2 : Configuration
- **Name** : `trainnomad-backend`
- **Region** : Europe West (Frankfurt)
- **Branch** : `main`
- **Runtime** : `Node`
- **Build Command** : `npm install`
- **Start Command** : `npm start`

### Étape 3 : Variables d'environnement
Sur Render, vous n'avez PAS besoin d'ajouter de variables pour l'instant.
Render définit automatiquement `PORT`.

### Étape 4 : Déployer
Cliquer sur **"Create Web Service"**

## ✅ Tester l'API

Une fois déployé sur Render :
```
https://votre-app.onrender.com/
https://votre-app.onrender.com/api/trajets
https://votre-app.onrender.com/api/billets?depart=Angers&arrivee=Nantes
```

## 🔧 Prochaines étapes

Pour connecter Supabase plus tard :
1. Installer : `npm install @supabase/supabase-js`
2. Ajouter les variables d'environnement sur Render :
   - `SUPABASE_URL`
   - `SUPABASE_KEY`
3. Modifier le code pour remplacer les données test par Supabase

## 📝 Structure du projet

```
trainnomad-backend/
├── server.js          # Serveur Express principal
├── package.json       # Dépendances Node.js
├── .env.example       # Exemple de variables d'environnement
└── README.md          # Ce fichier
```
