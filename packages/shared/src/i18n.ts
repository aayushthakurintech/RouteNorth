export const LOCALES = ["en", "fr"] as const;
export type Locale = (typeof LOCALES)[number];
export const DEFAULT_LOCALE: Locale = "en";

const en = {
  appName: "RouteNorth",
  tagline: "Simple, honest fleet tracking",
  signIn: "Sign in",
  signOut: "Sign out",
  email: "Email",
  password: "Password",
  loginFailed: "Wrong email or password.",
  language: "Language",
  searchVehicles: "Search vehicles",
  noVehicles: "No vehicles to show yet.",
  vehicles: "Vehicles",
  speed: "Speed",
  heading: "Heading",
  lastUpdate: "Last update",
  follow: "Follow",
  stopFollowing: "Stop following",
  trail: "Recent trail",
  connected: "Live",
  reconnecting: "Reconnecting…",
  status_moving: "Moving",
  status_idle: "Idle",
  status_stopped: "Stopped",
  status_offline: "Offline",
  kind_truck: "Truck",
  kind_bus: "Bus",
  kind_van: "Van",
  kind_car: "Car",
} as const;

export type MessageKey = keyof typeof en;

const fr: Record<MessageKey, string> = {
  appName: "RouteNorth",
  tagline: "Suivi de flotte simple et honnête",
  signIn: "Se connecter",
  signOut: "Se déconnecter",
  email: "Courriel",
  password: "Mot de passe",
  loginFailed: "Courriel ou mot de passe incorrect.",
  language: "Langue",
  searchVehicles: "Rechercher un véhicule",
  noVehicles: "Aucun véhicule à afficher pour l’instant.",
  vehicles: "Véhicules",
  speed: "Vitesse",
  heading: "Cap",
  lastUpdate: "Dernière mise à jour",
  follow: "Suivre",
  stopFollowing: "Arrêter le suivi",
  trail: "Trajet récent",
  connected: "En direct",
  reconnecting: "Reconnexion…",
  status_moving: "En mouvement",
  status_idle: "Au ralenti",
  status_stopped: "Arrêté",
  status_offline: "Hors ligne",
  kind_truck: "Camion",
  kind_bus: "Autobus",
  kind_van: "Fourgonnette",
  kind_car: "Voiture",
};

export const messages: Record<Locale, Record<MessageKey, string>> = { en, fr };

export function translate(locale: Locale, key: MessageKey): string {
  return messages[locale][key] ?? messages.en[key];
}
