/** Release notes shown in "What's new". Newest first. Add an entry whenever something people can see changes. */
export interface ReleaseNote { id: string; date: string; title: { en: string; fr: string }; body: { en: string; fr: string } }

export const RELEASE_NOTES: ReleaseNote[] = [
  {
    id: "2026-11-security", date: "2026-11-03",
    title: { en: "Two-factor sign-in, privacy tools and a help center", fr: "Connexion à deux facteurs, outils de confidentialité et centre d’aide" },
    body: {
      en: "Turn on an authenticator app, see and end your signed-in devices, keep drivers private off shift, export or delete your data, and find answers in Help and feedback. New pages: Security, Health, a public roadmap and a service status page.",
      fr: "Activez une appli d’authentification, voyez et fermez vos appareils connectés, protégez la vie privée des chauffeurs hors quart, exportez ou supprimez vos données et trouvez des réponses dans Aide et commentaires. Nouvelles pages : Sécurité, Santé, une feuille de route publique et l’état du service.",
    },
  },
  {
    id: "2026-11-business", date: "2026-11-03",
    title: { en: "Teams, tasks, quotes and driver pay", fr: "Équipes, tâches, devis et paie des chauffeurs" },
    body: {
      en: "Invite people by email, comment with @mentions, keep a to-do list, plan shifts and time off, build quotes and invoices with Canadian tax, price jobs with rate cards, and see budgets, driver pay and profit.",
      fr: "Invitez des gens par courriel, commentez avec des @mentions, tenez une liste de tâches, planifiez quarts et congés, créez devis et factures avec les taxes canadiennes, tarifez avec des grilles et suivez budgets, paie et profit.",
    },
  },
  {
    id: "2026-11-platform", date: "2026-11-03",
    title: { en: "Connect other systems", fr: "Connectez d’autres systèmes" },
    body: {
      en: "API keys, live data feeds for spreadsheets, an import wizard for files from other tools, custom fields and statuses, a tracking widget for your website and a developer guide.",
      fr: "Clés d’API, flux de données pour chiffriers, assistant d’importation de fichiers d’autres outils, champs et statuts personnalisés, widget de suivi pour votre site et guide du développeur.",
    },
  },
  {
    id: "2026-11-smart", date: "2026-11-03",
    title: { en: "Smart dispatch, optimization and safety", fr: "Répartition intelligente, optimisation et sécurité" },
    body: {
      en: "An assistant that answers questions about your fleet, route optimization with what-if plans, driver safety scores with coaching, and fatigue and break reminders.",
      fr: "Un assistant qui répond aux questions sur votre flotte, l’optimisation d’itinéraires avec scénarios, des cotes de sécurité avec coaching et des rappels de fatigue et de pauses.",
    },
  },
  {
    id: "2026-11-foundation", date: "2026-11-03",
    title: { en: "A new look, search everywhere, and roles", fr: "Nouveau look, recherche partout et rôles" },
    body: {
      en: "Light, dark and high-contrast themes, a collapsible menu, a command palette (Ctrl+K), global search, custom roles, and an audit log of every change.",
      fr: "Thèmes clair, sombre et à contraste élevé, menu rétractable, palette de commandes (Ctrl+K), recherche globale, rôles personnalisés et journal d’audit de chaque modification.",
    },
  },
  {
    id: "2026-11-driver", date: "2026-11-02",
    title: { en: "Driver app with offline proof of delivery", fr: "Appli chauffeur avec preuve de livraison hors ligne" },
    body: {
      en: "Drivers see today’s stops, navigate in one tap, and capture photos and signatures even without signal.",
      fr: "Les chauffeurs voient les arrêts du jour, naviguent en un clic et prennent photos et signatures même sans signal.",
    },
  },
];
