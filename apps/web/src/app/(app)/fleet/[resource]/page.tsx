"use client";
import { use } from "react";
import ResourcePage from "@/components/ResourcePage";

export default function FleetResource({ params }: { params: Promise<{ resource: string }> }) {
  const { resource } = use(params);
  return <ResourcePage name={resource} />;
}
