/**
 * Public legal text, English and French. These are drafts written to match what the product really does; they have not been reviewed by a lawyer.
 * The few facts only the company can supply (legal name, address, privacy officer, governing province) come from environment variables and show an obvious
 * placeholder until set, so nothing invented is ever shown as fact.
 */
export type Locale = "en" | "fr";
export interface Section { h: string; p?: string[]; ul?: string[] }
export interface Doc { title: string; intro: string; sections: Section[] }

import { TERMS_VERSION } from "@routenorth/shared";
export { TERMS_VERSION };
export const UPDATED = { en: "November 5, 2026", fr: "5 novembre 2026" };

const env = (name: string, fallback: string) => (typeof process !== "undefined" && process.env[name]) || fallback;
export const COMPANY = {
  name: env("NEXT_PUBLIC_COMPANY_NAME", "RouteNorth"),
  privacyEmail: env("NEXT_PUBLIC_PRIVACY_EMAIL", "privacy@routenorth.example"),
  supportEmail: env("NEXT_PUBLIC_SUPPORT_EMAIL", "support@routenorth.example"),
  province: env("NEXT_PUBLIC_GOVERNING_PROVINCE", "[province to be set before launch]"),
};

export const UI = {
  en: { draft: "Draft for legal review. This text describes how the product works today; it is not yet approved by counsel.", updated: "Last updated", version: "Version", on: "On this page", contact: "Contact", terms: "Terms of Service", privacy: "Privacy Notice", accessibility: "Accessibility Statement", back: "Back to home" },
  fr: { draft: "Ébauche à valider par un juriste. Ce texte décrit le fonctionnement actuel du produit; il n'a pas encore été approuvé par un conseiller juridique.", updated: "Dernière mise à jour", version: "Version", on: "Sur cette page", contact: "Contact", terms: "Conditions d'utilisation", privacy: "Avis de confidentialité", accessibility: "Déclaration d'accessibilité", back: "Retour à l'accueil" },
};

const terms: Record<Locale, Doc> = {
  en: {
    title: "Terms of Service",
    intro: "These terms are the agreement between your organization and RouteNorth for the fleet tracking service. By creating an account you confirm you can bind your organization and you accept them.",
    sections: [
      { h: "The service", p: ["RouteNorth shows where your vehicles are, reports distance, idling, fuel and utilization, and keeps hours-of-service clocks and a driver app. The 30-day free trial needs no payment card. Prices are shown on the pricing page in Canadian dollars, before tax."] },
      { h: "Your account", ul: ["You are responsible for who you give access to and for keeping passwords and two-factor methods safe.", "Tell us promptly if you think an account was used without permission.", "Information you give at sign-up must be accurate."] },
      { h: "Your data", p: ["Your fleet data (positions, trips, drivers, vehicles, documents) belongs to your organization. We process it only to run the service for you, as described in the Privacy Notice. You can export it, and you can delete your organization from the settings."] },
      { h: "Monitoring drivers", p: ["You are responsible for lawfully tracking your drivers. Before you track a person, tell them what is collected, why, and when. Use the setting that records location only during shifts where that fits your policy. Follow the privacy and employment rules of your province."] },
      { h: "Hours of service and estimates", p: ["The hours-of-service screens are an aid for awareness. RouteNorth is not a certified electronic logging device (ELD) and the screens are not the driver's official record of duty status. Idling, fuel, cost and CO₂ figures are estimates built from the data your trackers send; the screens show how each figure is worked out. Check them before you rely on them for payroll, billing or compliance decisions."] },
      { h: "Acceptable use", ul: ["Do not use the service to track people without their knowledge where the law requires notice.", "Do not try to break, overload, or get around the limits or security of the service, or use it to harm others.", "Do not resell the service without a written agreement."] },
      { h: "Availability and changes", p: ["We work to keep the service running and publish its status and incident history. We do not promise it will always be uninterrupted or error free. We may change features; if a change materially reduces what you pay for we will tell you in advance."] },
      { h: "Fees and cancellation", p: ["After the trial, paid plans are charged as stated on the pricing page. You can cancel at any time; access continues to the end of the paid period. On cancellation you can export your data, and we delete it after the retention period you set."] },
      { h: "Liability", p: ["To the extent the law allows, RouteNorth is not liable for indirect or consequential losses, and its total liability is limited to the fees you paid in the twelve months before the claim. Nothing here limits liability that the law does not allow to be limited, including for consumer rights in Quebec."] },
      { h: "Governing law", p: [`These terms are governed by the laws of ${COMPANY.province} and the federal laws of Canada that apply there. Disputes go to the courts of that province, except where the law gives you the right to go elsewhere.`] },
      { h: "Changes to these terms", p: ["If we change these terms we will update the date and version above and tell account owners by email before the change takes effect. These terms are also available in French; if the two differ where the law allows a choice, the version you accepted applies."] },
    ],
  },
  fr: {
    title: "Conditions d'utilisation",
    intro: "Ces conditions forment l'entente entre votre organisation et RouteNorth pour le service de suivi de flotte. En créant un compte, vous confirmez pouvoir engager votre organisation et vous les acceptez.",
    sections: [
      { h: "Le service", p: ["RouteNorth montre où sont vos véhicules, calcule la distance, le ralenti, le carburant et l'utilisation, et tient des horloges d'heures de service et une application pour conducteurs. L'essai gratuit de 30 jours ne demande aucune carte de paiement. Les prix figurent sur la page des tarifs, en dollars canadiens, avant taxes."] },
      { h: "Votre compte", ul: ["Vous êtes responsable des personnes à qui vous donnez accès et de la protection des mots de passe et des méthodes à deux facteurs.", "Avisez-nous rapidement si vous pensez qu'un compte a été utilisé sans permission.", "Les renseignements fournis à l'inscription doivent être exacts."] },
      { h: "Vos données", p: ["Vos données de flotte (positions, trajets, conducteurs, véhicules, documents) appartiennent à votre organisation. Nous les traitons seulement pour offrir le service, comme décrit dans l'avis de confidentialité. Vous pouvez les exporter et supprimer votre organisation depuis les paramètres."] },
      { h: "Surveillance des conducteurs", p: ["Il vous revient de suivre vos conducteurs de façon licite. Avant de suivre une personne, dites-lui ce qui est recueilli, pourquoi et quand. Utilisez le réglage qui n'enregistre la position que pendant les quarts lorsque cela convient à votre politique. Respectez les règles de protection de la vie privée et d'emploi de votre province."] },
      { h: "Heures de service et estimations", p: ["Les écrans d'heures de service sont une aide à la vigilance. RouteNorth n'est pas un dispositif de consignation électronique (DCE) certifié et ces écrans ne sont pas le registre officiel du conducteur. Les chiffres de ralenti, de carburant, de coût et de CO₂ sont des estimations fondées sur les données envoyées par vos traceurs; chaque écran montre comment le chiffre est calculé. Vérifiez-les avant de vous y fier pour la paie, la facturation ou la conformité."] },
      { h: "Utilisation acceptable", ul: ["N'utilisez pas le service pour suivre des personnes à leur insu lorsque la loi exige un avis.", "N'essayez pas de briser ou de surcharger le service, d'en contourner les limites ou la sécurité, ni de l'utiliser pour nuire à autrui.", "Ne revendez pas le service sans entente écrite."] },
      { h: "Disponibilité et modifications", p: ["Nous faisons le nécessaire pour que le service fonctionne et nous publions son état et l'historique des incidents. Nous ne promettons pas qu'il soit toujours sans interruption ni sans erreur. Nous pouvons modifier des fonctions; si un changement réduit de façon importante ce que vous payez, nous vous en aviserons à l'avance."] },
      { h: "Frais et annulation", p: ["Après l'essai, les forfaits payants sont facturés comme indiqué sur la page des tarifs. Vous pouvez annuler en tout temps; l'accès se poursuit jusqu'à la fin de la période payée. À l'annulation, vous pouvez exporter vos données, et nous les supprimons après la durée de conservation que vous avez fixée."] },
      { h: "Responsabilité", p: ["Dans la mesure permise par la loi, RouteNorth n'est pas responsable des pertes indirectes ou consécutives et sa responsabilité totale se limite aux frais payés au cours des douze mois précédant la réclamation. Rien ici ne limite une responsabilité que la loi interdit de limiter, notamment les droits des consommateurs au Québec."] },
      { h: "Droit applicable", p: [`Ces conditions sont régies par les lois de ${COMPANY.province} et les lois fédérales du Canada qui s'y appliquent. Les litiges relèvent des tribunaux de cette province, sauf lorsque la loi vous permet de vous adresser ailleurs.`] },
      { h: "Modification des conditions", p: ["Si nous modifions ces conditions, nous mettrons à jour la date et la version ci-dessus et nous aviserons par courriel les titulaires de compte avant l'entrée en vigueur. Ces conditions sont aussi offertes en anglais."] },
    ],
  },
};

const privacy: Record<Locale, Doc> = {
  en: {
    title: "Privacy Notice",
    intro: "This notice explains what personal information RouteNorth handles, why, and the choices you have. It follows the federal Personal Information Protection and Electronic Documents Act (PIPEDA), Quebec's Law 25, and Canada's Anti-Spam Legislation (CASL).",
    sections: [
      { h: "Who is responsible", p: ["For the account details of the people who sign in, RouteNorth is the organization responsible for the information. For your fleet data, including the positions and trips of your drivers, your organization decides why and how it is collected and RouteNorth handles it on your behalf. If you are a driver and have a question about your own data, ask your employer first.", `Privacy officer (Law 25): ${COMPANY.privacyEmail}.`] },
      { h: "What we collect", ul: ["Account: name, work email, password (stored only as a salted hash), language, role, sign-in and security events.", "Fleet: vehicle and tracker details, GPS positions, speed, heading, ignition and sensor readings, trips, idling, fuel, driver assignments, shifts and hours-of-service entries, delivery proof you or your drivers add.", "Driver app: location while a shift or route is active, as the app runs in the foreground.", "Technical: IP address and browser details for security, rate limiting and the audit log."] },
      { h: "Why we use it", ul: ["To run the service you asked for: live maps, reports, alerts and the driver app.", "To keep accounts and data safe: sign-in checks, two-factor, audit trail, abuse prevention.", "To support you and improve the service using aggregate and error information.", "To send service messages (invites, password resets, alerts you turn on). Marketing messages are sent only if you agree."] },
      { h: "Consent and drivers", p: ["Account owners accept our terms and this notice when they sign up; the version and time are recorded. The checkbox for product news is off until you tick it, and you can withdraw at any time. Drivers should be told by their employer what is tracked; the location-only-during-shifts setting limits tracking to working time."] },
      { h: "Cookies and similar storage", p: ["RouteNorth uses only what the service needs: a session, and your language and theme choices. It does not use advertising or cross-site tracking."] },
      { h: "Who we share with", ul: ["Service providers that help run the product, such as hosting, email delivery and map tiles, under contract and only for that purpose.", "Your own organization's users, according to the roles you set.", "Authorities where the law requires it.", "We do not sell personal information."] },
      { h: "Where it is stored", p: ["Data is stored with our hosting provider in the region set for your deployment, with encryption in transit and at rest provided by that host. Information can be handled by providers outside your province or Canada; where Law 25 applies we assess the risk before such a transfer."] },
      { h: "How long we keep it", p: ["You set retention for positions and messages in the organization settings. When the period ends the data is deleted. Account details are kept while the account is open. Audit records are kept for security and legal needs. Backups age out on their own cycle."] },
      { h: "Your rights", ul: ["See the personal information we hold about you and get a copy, including in a common format.", "Ask for corrections and for deletion, subject to what the law requires us to keep.", "Withdraw consent for optional uses such as marketing.", "In Quebec, ask for information about decisions made only by automated processing; RouteNorth's driver safety score is shown with its formula and is meant to inform a person, not decide for one.", "Organization owners can export or erase a person's data from the privacy pages in settings."] },
      { h: "Security and incidents", p: ["We use row-level isolation between organizations, roles and permissions, optional two-factor sign-in, an audit log and encryption of secrets. No system is perfectly safe and RouteNorth is not certified to SOC 2 or ISO 27001. If an incident creates a real risk of significant harm we report it to the Office of the Privacy Commissioner of Canada or the Commission d'accès à l'information du Québec as applicable, tell the people affected, and keep an incident register."] },
      { h: "Email and CASL", p: ["Service messages are sent because you use the product. We do not send marketing email today. If we start, it will go only to people who ticked the product news box at sign-up or otherwise gave express consent, will identify us, and will carry a working unsubscribe link that we honour within ten business days."] },
      { h: "Questions and complaints", p: [`Write to ${COMPANY.privacyEmail}. If you are not satisfied you may complain to the Office of the Privacy Commissioner of Canada, or in Quebec to the Commission d'accès à l'information.`] },
    ],
  },
  fr: {
    title: "Avis de confidentialité",
    intro: "Cet avis explique quels renseignements personnels RouteNorth traite, pourquoi, et les choix qui s'offrent à vous. Il suit la Loi sur la protection des renseignements personnels et les documents électroniques (LPRPDE), la Loi 25 du Québec et la Loi canadienne anti-pourriel (LCAP).",
    sections: [
      { h: "Qui est responsable", p: ["Pour les renseignements de compte des personnes qui se connectent, RouteNorth est l'organisation responsable. Pour vos données de flotte, y compris les positions et trajets de vos conducteurs, votre organisation décide pourquoi et comment elles sont recueillies et RouteNorth les traite pour votre compte. Si vous êtes conducteur et avez une question sur vos données, adressez-vous d'abord à votre employeur.", `Responsable de la protection des renseignements personnels (Loi 25) : ${COMPANY.privacyEmail}.`] },
      { h: "Ce que nous recueillons", ul: ["Compte : nom, courriel de travail, mot de passe (conservé seulement sous forme de condensat salé), langue, rôle, événements de connexion et de sécurité.", "Flotte : détails des véhicules et des traceurs, positions GPS, vitesse, cap, allumage et lectures de capteurs, trajets, ralenti, carburant, affectations, quarts et entrées d'heures de service, preuves de livraison que vous ou vos conducteurs ajoutez.", "Application conducteur : la position pendant un quart ou un parcours actif, l'application étant au premier plan.", "Technique : adresse IP et détails du navigateur pour la sécurité, la limitation de débit et le journal d'audit."] },
      { h: "Pourquoi nous les utilisons", ul: ["Pour offrir le service demandé : cartes en direct, rapports, alertes et application conducteur.", "Pour protéger les comptes et les données : vérifications de connexion, authentification à deux facteurs, journal d'audit, prévention des abus.", "Pour vous aider et améliorer le service à partir d'informations agrégées et d'erreurs.", "Pour envoyer des messages de service (invitations, réinitialisations, alertes que vous activez). Les messages promotionnels ne sont envoyés que si vous y consentez."] },
      { h: "Consentement et conducteurs", p: ["Les titulaires de compte acceptent nos conditions et cet avis à l'inscription; la version et l'heure sont consignées. La case pour les nouvelles du produit est décochée tant que vous ne la cochez pas, et vous pouvez retirer votre consentement en tout temps. Les conducteurs doivent être informés par leur employeur de ce qui est suivi; le réglage de suivi limité aux quarts restreint le suivi aux heures de travail."] },
      { h: "Témoins et stockage semblable", p: ["RouteNorth n'utilise que le nécessaire au service : une session, ainsi que vos choix de langue et de thème. Il n'utilise ni publicité ni suivi intersite."] },
      { h: "Avec qui nous partageons", ul: ["Les fournisseurs qui aident à exploiter le produit, comme l'hébergement, l'envoi de courriels et les tuiles de carte, par contrat et seulement à cette fin.", "Les utilisateurs de votre propre organisation, selon les rôles que vous définissez.", "Les autorités lorsque la loi l'exige.", "Nous ne vendons pas de renseignements personnels."] },
      { h: "Où ils sont stockés", p: ["Les données sont stockées chez notre hébergeur, dans la région choisie pour votre déploiement, avec chiffrement en transit et au repos assuré par cet hébergeur. Des fournisseurs situés hors de votre province ou du Canada peuvent traiter des renseignements; lorsque la Loi 25 s'applique, nous évaluons le risque avant un tel transfert."] },
      { h: "Durée de conservation", p: ["Vous fixez la conservation des positions et des messages dans les paramètres de l'organisation. À la fin de la période, les données sont supprimées. Les renseignements de compte sont conservés tant que le compte est ouvert. Les registres d'audit sont conservés pour des besoins de sécurité et juridiques. Les sauvegardes expirent selon leur propre cycle."] },
      { h: "Vos droits", ul: ["Consulter les renseignements personnels que nous détenons à votre sujet et en obtenir une copie, y compris dans un format courant.", "Demander la correction et la suppression, sous réserve de ce que la loi nous oblige à conserver.", "Retirer votre consentement aux usages facultatifs comme la promotion.", "Au Québec, demander des renseignements sur les décisions prises uniquement par traitement automatisé; la cote de sécurité du conducteur de RouteNorth est affichée avec sa formule et vise à informer une personne, non à décider à sa place.", "Les propriétaires d'organisation peuvent exporter ou effacer les données d'une personne depuis les pages de confidentialité des paramètres."] },
      { h: "Sécurité et incidents", p: ["Nous utilisons l'isolation par ligne entre organisations, des rôles et permissions, une connexion à deux facteurs facultative, un journal d'audit et le chiffrement des secrets. Aucun système n'est parfaitement sûr et RouteNorth n'est pas certifié SOC 2 ni ISO 27001. Si un incident crée un risque réel de préjudice sérieux, nous le signalons au Commissariat à la protection de la vie privée du Canada ou à la Commission d'accès à l'information du Québec selon le cas, avisons les personnes touchées et tenons un registre des incidents."] },
      { h: "Courriel et LCAP", p: ["Les messages de service sont envoyés parce que vous utilisez le produit. Nous n'envoyons pas de courriels promotionnels actuellement. Si nous commençons, ils ne seront envoyés qu'aux personnes ayant coché la case des nouvelles du produit à l'inscription ou donné autrement un consentement exprès, nous identifieront et comporteront un lien de désabonnement fonctionnel que nous respectons dans les dix jours ouvrables."] },
      { h: "Questions et plaintes", p: [`Écrivez à ${COMPANY.privacyEmail}. Si vous n'êtes pas satisfait, vous pouvez porter plainte au Commissariat à la protection de la vie privée du Canada ou, au Québec, à la Commission d'accès à l'information.`] },
    ],
  },
};

const accessibility: Record<Locale, Doc> = {
  en: {
    title: "Accessibility Statement",
    intro: "We want RouteNorth to be usable by everyone who works in a fleet, including people who use a keyboard, a screen reader, zoom or high contrast. Our target is WCAG 2.2 level AA, which also supports your duties under the Accessible Canada Act and provincial laws such as the AODA in Ontario.",
    sections: [
      { h: "What we do today", ul: ["Every screen works with a keyboard, with a visible focus outline and a skip-to-content link.", "Colours are chosen for contrast in light, dark and high-contrast modes; status is never shown by colour alone.", "Charts have a table view, a text summary and keyboard-reachable values; the live map has a list of the same vehicles.", "Forms have labels, helpful error messages and password fields that can be shown.", "The product and this site are in English and French, and respect reduced-motion settings.", "We run automated accessibility checks (axe) on the public pages and main screens at phone and desktop widths and fix what they report."] },
      { h: "Known limits", ul: ["Automated checks find only part of the problems. RouteNorth has not yet had an audit by an independent accessibility specialist or testing with assistive-technology users, so we do not claim conformance.", "Map tiles and the route drawing are visual; use the vehicle list and the trip table for the same information.", "The driver app is a web app; background tracking and some device features are not available in it."] },
      { h: "Tell us about a barrier", p: [`If something does not work for you, write to ${COMPANY.supportEmail} with the page and what happened. We reply within five business days and will offer the information another way while we fix it.`] },
    ],
  },
  fr: {
    title: "Déclaration d'accessibilité",
    intro: "Nous voulons que RouteNorth soit utilisable par toutes les personnes qui travaillent dans une flotte, y compris celles qui utilisent le clavier, un lecteur d'écran, le zoom ou le contraste élevé. Notre cible est le niveau AA des WCAG 2.2, ce qui soutient aussi vos obligations en vertu de la Loi canadienne sur l'accessibilité et de lois provinciales comme la LAPHO en Ontario.",
    sections: [
      { h: "Ce que nous faisons aujourd'hui", ul: ["Chaque écran fonctionne au clavier, avec un contour de focus visible et un lien d'accès direct au contenu.", "Les couleurs sont choisies pour le contraste en modes clair, sombre et contraste élevé; l'état n'est jamais indiqué par la couleur seule.", "Les graphiques offrent une vue en tableau, un résumé textuel et des valeurs accessibles au clavier; la carte en direct est accompagnée d'une liste des mêmes véhicules.", "Les formulaires ont des étiquettes, des messages d'erreur utiles et des champs de mot de passe qu'on peut afficher.", "Le produit et ce site sont en français et en anglais, et respectent la préférence de mouvement réduit.", "Nous exécutons des vérifications automatiques d'accessibilité (axe) sur les pages publiques et les écrans principaux, sur téléphone et ordinateur, et corrigeons ce qu'elles signalent."] },
      { h: "Limites connues", ul: ["Les vérifications automatiques ne trouvent qu'une partie des problèmes. RouteNorth n'a pas encore fait l'objet d'un audit par un spécialiste indépendant ni de tests avec des utilisateurs de technologies d'assistance; nous ne prétendons donc pas à la conformité.", "Les tuiles de carte et le tracé des parcours sont visuels; utilisez la liste des véhicules et le tableau des trajets pour la même information.", "L'application conducteur est une application web; le suivi en arrière-plan et certaines fonctions de l'appareil n'y sont pas offerts."] },
      { h: "Signalez-nous un obstacle", p: [`Si quelque chose ne fonctionne pas pour vous, écrivez à ${COMPANY.supportEmail} en précisant la page et ce qui s'est passé. Nous répondons dans les cinq jours ouvrables et offrirons l'information autrement pendant la correction.`] },
    ],
  },
};

export const DOCS = { terms, privacy, accessibility } as const;
export type DocKey = keyof typeof DOCS;
