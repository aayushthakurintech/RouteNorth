/** Release notes shown in "What's new". Newest first. Add an entry whenever something people can see changes. */
export interface ReleaseNote { id: string; date: string; title: { en: string; fr: string }; body: { en: string; fr: string } }

export const RELEASE_NOTES: ReleaseNote[] = [
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
