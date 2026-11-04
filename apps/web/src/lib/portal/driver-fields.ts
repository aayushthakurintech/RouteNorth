import type { FieldSpec } from "@/components/portal/field-form";

export const DRIVER_STATUS_LABEL: Record<string, string> = { applicant: "Applicant", onboarding: "Onboarding", active: "Active", on_trip: "On trip", off_duty: "Off duty", suspended: "Suspended", archived: "Archived" };
export const DRIVER_STATUS_TONE: Record<string, "good" | "info" | "warn" | "bad" | "neutral"> = { applicant: "neutral", onboarding: "warn", active: "good", on_trip: "info", off_duty: "neutral", suspended: "bad", archived: "neutral" };
export const STORED_DRIVER_STATUSES = [{ value: "onboarding", label: "Onboarding" }, { value: "active", label: "Active" }, { value: "off_duty", label: "Off duty" }, { value: "suspended", label: "Suspended" }];

export const PERSONAL_FORM: FieldSpec[] = [
  { key: "displayName", label: "Full name" }, { key: "phone", label: "Phone" }, { key: "address", label: "Address", wide: true },
  { key: "birthDate", label: "Date of birth", type: "date" }, { key: "languages", label: "Languages", type: "tags", help: "Separate with commas." },
  { key: "homeBase", label: "Home base" }, { key: "employmentType", label: "Employee or contractor", type: "select", options: [{ value: "employee", label: "Employee" }, { value: "contractor", label: "Contractor" }] },
  { key: "licenseNo", label: "Licence number" }, { key: "licenseClass", label: "Licence class", help: "For example G, AZ, DZ, B." }, { key: "licenseExpiry", label: "Licence expires", type: "date" },
  { key: "emergencyName", label: "Emergency contact" }, { key: "emergencyPhone", label: "Emergency phone" },
  { key: "workPermitRequired", label: "Work permit required", type: "checkbox" }, { key: "leaderboardOptOut", label: "Hide from the leaderboard", type: "checkbox" },
  { key: "notes", label: "Notes", type: "textarea" },
];
