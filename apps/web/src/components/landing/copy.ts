/**
 * Words on the public website, in English and French. Kept apart from the app's message files because this page is
 * written, not translated string by string: the French is its own copy.
 * Reviews are samples. They are placeholders for real customer words and say so on the page.
 */
export interface Plan { id: "starter" | "pro" | "enterprise"; name: string; blurb: string; cta: string }
export interface Copy {
  nav: { features: string; pricing: string; faq: string; signIn: string; start: string; menu: string };
  hero: { h1a: string; h1b: string; sub: string; cta: string; second: string; demo: string; fleet: string; moving: string; idle: string; kmh: string };
  features: { title: string; tiles: { name: string; line: string; fig: string }[] };
  showcase: { title: string; items: { name: string; fact: string }[]; demo: string };
  how: { title: string; steps: { order: string; clause: string; card: string[] }[] };
  reviews: { title: string; sample: string; note: string; items: { quote: string; name: string; role: string }[] };
  pricing: { plans: Plan[]; perMonth: string; vehicles: string; includes: Record<Plan["id"], string>; over: string; taxNote: string; trial: string; custom: string; limits: (v: number | null, u: number | null, jobs: number | null) => string };
  faq: { title: string; items: { q: string; a: string }[] };
  cta: { word: string; sentence: string };
  footer: { product: string; account: string; legal: string; contact: string; rights: string; contactLine: string; links: { features: string; pricing: string; faq: string; signIn: string; start: string; terms: string; privacy: string; accessibility: string; security: string; status: string; help: string } };
}

export const COPY: Record<"en" | "fr", Copy> = {
  en: {
    nav: { features: "Features", pricing: "Pricing", faq: "Questions", signIn: "Sign in", start: "Start free trial", menu: "Menu" },
    hero: {
      h1a: "Every truck and bus,", h1b: "on one honest map.",
      sub: "RouteNorth tracks your vehicles live, counts idling and fuel, and keeps hours-of-service clocks. Every number comes with the working shown.",
      cta: "Start your free trial", second: "See how it works",
      demo: "Demo fleet", fleet: "Vehicles", moving: "Moving", idle: "Idle", kmh: "km/h",
    },
    features: {
      title: "What you get",
      tiles: [
        { name: "Live map", line: "Speed, heading and last report for every vehicle.", fig: "38 km/h" },
        { name: "Idling cost", line: "Engine-on stops, priced in litres, dollars and CO₂.", fig: "$74.37" },
        { name: "Hours of service", line: "Canadian and US clocks, with the next limit.", fig: "3 h 12 min" },
        { name: "Tracker health", line: "See which devices are quiet before a driver calls.", fig: "Healthy" },
        { name: "Fuel events", line: "Refuels and possible drains from the fuel sensor.", fig: "21% → 92%" },
        { name: "Utilization", line: "Which vehicles earn their keep, and which sit.", fig: "57%" },
        { name: "Driver app", line: "Stops, proof of delivery and offline sync on a phone.", fig: "Complete delivery" },
      ],
    },
    showcase: {
      title: "See it work",
      demo: "Demo data",
      items: [
        { name: "Live map", fact: "Direction arrows, status colours and a trail for the vehicle you pick." },
        { name: "Idling and fuel", fact: "Idle fuel is an estimate from typical burn rates, and the report says so." },
        { name: "Hours of service", fact: "Awareness for dispatch. It is not a certified electronic logging device." },
        { name: "Driver app", fact: "Installs from the browser, works offline, and syncs when coverage returns." },
      ],
    },
    how: {
      title: "How it starts",
      steps: [
        { order: "First you add a tracker.", clause: "Type its ID and pick the vehicle.", card: ["Tracker T-4821", "Waiting for first report"] },
        { order: "Then it reports.", clause: "Position, speed and sensors arrive in seconds.", card: ["Truck 7", "Moving · 38 km/h"] },
        { order: "Then the numbers add up.", clause: "Idling, fuel and distance, per day and vehicle.", card: ["Truck 7 · today", "Idle 41 min · $12.40"] },
        { order: "Then you act on them.", clause: "Move a route, call a driver, fix a habit.", card: ["Driver check", "3 h 12 min left to drive"] },
      ],
    },
    reviews: {
      title: "What owners say",
      sample: "Sample review",
      note: "These are written as placeholders, not quotes from customers. Real reviews replace them as customers write them.",
      items: [
        { quote: "“I used to find out about idling from the fuel bill. Now I see it the same day.”", name: "Sample name", role: "Owner of a regional delivery fleet" },
        { quote: "“Dispatch can see who is close to their hours without asking anyone.”", name: "Sample name", role: "Dispatcher at a motorcoach operator" },
        { quote: "“The driver app works in the depot basement. That alone sold the drivers.”", name: "Sample name", role: "Fleet manager at a school bus contractor" },
      ],
    },
    pricing: {
      plans: [
        { id: "starter", name: "Starter", blurb: "For a small fleet getting started.", cta: "Start with Starter" },
        { id: "pro", name: "Pro", blurb: "For fleets that run on reports.", cta: "Start with Pro" },
        { id: "enterprise", name: "Enterprise", blurb: "For large or regulated fleets.", cta: "Start with Enterprise" },
      ],
      perMonth: "per month", vehicles: "Vehicles",
      includes: {
        starter: "The full product: live map, reports, hours-of-service clocks, dispatch, alerts and the driver app.",
        pro: "The full product, sized for a growing fleet. A base fee plus a price for each vehicle.",
        enterprise: "The full product with no limit on vehicles or people. A base fee plus a lower price per vehicle.",
      },
      over: "This plan covers up to {n} vehicles. Pick a larger plan.",
      taxNote: "Canadian dollars, before tax.", trial: "30-day free trial. No credit card needed.",
      custom: "Talk to us for volume pricing.",
      limits: (v, u, j) => (v == null ? "No limit on vehicles, people or jobs" : `Up to ${v} vehicles, ${u} people and ${j} jobs a month`),
    },
    faq: {
      title: "Questions",
      items: [
        { q: "Which trackers work with RouteNorth?", a: "RouteNorth reads positions from Traccar, which decodes more than 200 tracker protocols, and from phones and other systems through a simple API. We have tested with a simulator and recorded messages. Check your exact device model with us before you buy hardware." },
        { q: "Is RouteNorth a certified ELD?", a: "No. The hours-of-service clocks are for planning and awareness, built from shifts, breaks and when the vehicle moved. If you need a certified electronic logging device, use one alongside RouteNorth." },
        { q: "How accurate are idling and fuel numbers?", a: "Idling time comes from your tracker's data. Fuel burned while idling is an estimate from typical rates per vehicle type, and it is labelled that way. Fuel events need a tracker with a fuel sensor." },
        { q: "How do you handle driver location privacy?", a: "Drivers can be tracked only during their shifts. You set how long positions are kept, and you can export or erase a person's data. Read the privacy notice for what we collect and why." },
        { q: "Is it available in French?", a: "Yes. The app and this website are in English and French, and the app is partly translated into Punjabi and Arabic." },
        { q: "Does the driver app work without coverage?", a: "Yes. Stops, signatures and photos are saved on the phone and sync when coverage returns. Keep the app open after you regain signal." },
        { q: "What does the free trial include?", a: "Thirty days with the features of the plan you choose, and no credit card. Your data stays if you carry on." },
      ],
    },
    cta: { word: "Start", sentence: "Create your account and add your first vehicle in minutes." },
    footer: {
      product: "Product", account: "Account", legal: "Legal", contact: "Help", rights: "© 2026 RouteNorth. All rights reserved.",
      contactLine: "Questions about RouteNorth? Open the help centre once you are signed in.",
      links: { features: "Features", pricing: "Pricing", faq: "Questions", signIn: "Sign in", start: "Start free trial", terms: "Terms of Service", privacy: "Privacy Notice", accessibility: "Accessibility", security: "Security", status: "Status", help: "Help centre" },
    },
  },
  fr: {
    nav: { features: "Fonctions", pricing: "Tarifs", faq: "Questions", signIn: "Connexion", start: "Essai gratuit", menu: "Menu" },
    hero: {
      h1a: "Chaque camion et autobus,", h1b: "sur une carte honnête.",
      sub: "RouteNorth suit vos véhicules en direct, calcule le ralenti et le carburant, et tient les horloges d'heures de service. Chaque chiffre montre son calcul.",
      cta: "Commencer l'essai gratuit", second: "Voir comment ça marche",
      demo: "Flotte de démonstration", fleet: "Véhicules", moving: "En route", idle: "Au ralenti", kmh: "km/h",
    },
    features: {
      title: "Ce que vous obtenez",
      tiles: [
        { name: "Carte en direct", line: "Vitesse, cap et dernier rapport de chaque véhicule.", fig: "38 km/h" },
        { name: "Coût du ralenti", line: "Arrêts moteur en marche, en litres, dollars et CO₂.", fig: "74,37 $" },
        { name: "Heures de service", line: "Horloges canadiennes et américaines, avec la prochaine limite.", fig: "3 h 12 min" },
        { name: "Santé des traceurs", line: "Voyez quels appareils sont silencieux avant l'appel d'un conducteur.", fig: "En santé" },
        { name: "Carburant", line: "Pleins et vidanges possibles, d'après la jauge.", fig: "21 % → 92 %" },
        { name: "Utilisation", line: "Quels véhicules travaillent, et lesquels dorment.", fig: "57 %" },
        { name: "Appli conducteur", line: "Arrêts, preuve de livraison et synchronisation hors ligne.", fig: "Livraison terminée" },
      ],
    },
    showcase: {
      title: "Voyez-le à l'œuvre",
      demo: "Données de démonstration",
      items: [
        { name: "Carte en direct", fact: "Flèches de direction, couleurs d'état et trajet du véhicule choisi." },
        { name: "Ralenti et carburant", fact: "Le carburant au ralenti est une estimation d'après des taux typiques, et le rapport le dit." },
        { name: "Heures de service", fact: "Un repère pour la répartition. Ce n'est pas un enregistreur électronique certifié." },
        { name: "Appli conducteur", fact: "S'installe depuis le navigateur, fonctionne hors ligne et se synchronise au retour du réseau." },
      ],
    },
    how: {
      title: "Comment ça commence",
      steps: [
        { order: "D'abord, vous ajoutez un traceur.", clause: "Entrez son identifiant et choisissez le véhicule.", card: ["Traceur T-4821", "En attente du premier rapport"] },
        { order: "Ensuite, il transmet.", clause: "Position, vitesse et capteurs arrivent en quelques secondes.", card: ["Camion 7", "En route · 38 km/h"] },
        { order: "Puis les chiffres s'additionnent.", clause: "Ralenti, carburant et distance, par jour et par véhicule.", card: ["Camion 7 · aujourd'hui", "Ralenti 41 min · 12,40 $"] },
        { order: "Enfin, vous agissez.", clause: "Déplacez un trajet, appelez un conducteur, corrigez une habitude.", card: ["Vérification conducteur", "Il reste 3 h 12 de conduite"] },
      ],
    },
    reviews: {
      title: "Ce que disent les propriétaires",
      sample: "Exemple d'avis",
      note: "Ces textes sont des exemples rédigés d'avance, pas des citations de clients. De vrais avis les remplaceront.",
      items: [
        { quote: "« Je découvrais le ralenti sur la facture de carburant. Maintenant, je le vois le jour même. »", name: "Nom d'exemple", role: "Propriétaire d'une flotte de livraison régionale" },
        { quote: "« La répartition voit qui approche de ses heures sans avoir à demander. »", name: "Nom d'exemple", role: "Répartiteur chez un exploitant d'autocars" },
        { quote: "« L'appli fonctionne dans le sous-sol du dépôt. C'est ce qui a convaincu les conducteurs. »", name: "Nom d'exemple", role: "Gestionnaire de flotte chez un transporteur scolaire" },
      ],
    },
    pricing: {
      plans: [
        { id: "starter", name: "Départ", blurb: "Pour une petite flotte qui commence.", cta: "Commencer avec Départ" },
        { id: "pro", name: "Pro", blurb: "Pour les flottes qui roulent aux rapports.", cta: "Commencer avec Pro" },
        { id: "enterprise", name: "Entreprise", blurb: "Pour les flottes grandes ou réglementées.", cta: "Commencer avec Entreprise" },
      ],
      perMonth: "par mois", vehicles: "Véhicules",
      includes: {
        starter: "Le produit complet : carte en direct, rapports, heures de service, répartition, alertes et appli conducteur.",
        pro: "Le produit complet, dimensionné pour une flotte en croissance. Des frais de base et un prix par véhicule.",
        enterprise: "Le produit complet sans limite de véhicules ni de personnes. Des frais de base et un prix réduit par véhicule.",
      },
      over: "Ce forfait couvre jusqu'à {n} véhicules. Choisissez un forfait plus grand.",
      taxNote: "Dollars canadiens, avant taxes.", trial: "Essai gratuit de 30 jours. Aucune carte de crédit requise.",
      custom: "Parlez-nous pour un tarif de volume.",
      limits: (v, u, j) => (v == null ? "Aucune limite de véhicules, de personnes ni de travaux" : `Jusqu'à ${v} véhicules, ${u} personnes et ${j} travaux par mois`),
    },
    faq: {
      title: "Questions",
      items: [
        { q: "Quels traceurs fonctionnent avec RouteNorth ?", a: "RouteNorth lit les positions de Traccar, qui décode plus de 200 protocoles de traceurs, et de téléphones et autres systèmes par une API simple. Nous avons testé avec un simulateur et des messages enregistrés. Vérifiez votre modèle exact avec nous avant d'acheter du matériel." },
        { q: "RouteNorth est-il un ELD certifié ?", a: "Non. Les horloges d'heures de service servent à planifier et à surveiller, d'après les quarts, les pauses et les déplacements du véhicule. Si vous avez besoin d'un enregistreur électronique certifié, utilisez-en un en parallèle." },
        { q: "Quelle est la précision du ralenti et du carburant ?", a: "Le temps de ralenti vient des données de votre traceur. Le carburant brûlé au ralenti est une estimation d'après des taux typiques par type de véhicule, et c'est indiqué. Les événements de carburant exigent un traceur avec jauge." },
        { q: "Comment protégez-vous la vie privée des conducteurs ?", a: "Les conducteurs peuvent n'être suivis que pendant leurs quarts. Vous fixez la durée de conservation des positions et vous pouvez exporter ou effacer les données d'une personne. Lisez l'avis de confidentialité pour savoir ce que nous recueillons et pourquoi." },
        { q: "Est-ce offert en français ?", a: "Oui. L'application et ce site sont en français et en anglais, et l'application est en partie traduite en pendjabi et en arabe." },
        { q: "L'appli conducteur fonctionne-t-elle sans réseau ?", a: "Oui. Arrêts, signatures et photos sont enregistrés sur le téléphone et se synchronisent au retour du réseau. Gardez l'application ouverte après avoir retrouvé le signal." },
        { q: "Que comprend l'essai gratuit ?", a: "Trente jours avec les fonctions du forfait choisi, sans carte de crédit. Vos données restent si vous continuez." },
      ],
    },
    cta: { word: "Début", sentence: "Créez votre compte et ajoutez votre premier véhicule en quelques minutes." },
    footer: {
      product: "Produit", account: "Compte", legal: "Juridique", contact: "Aide", rights: "© 2026 RouteNorth. Tous droits réservés.",
      contactLine: "Une question sur RouteNorth ? Ouvrez le centre d'aide une fois connecté.",
      links: { features: "Fonctions", pricing: "Tarifs", faq: "Questions", signIn: "Connexion", start: "Essai gratuit", terms: "Conditions d'utilisation", privacy: "Avis de confidentialité", accessibility: "Accessibilité", security: "Sécurité", status: "État du service", help: "Centre d'aide" },
    },
  },
};
