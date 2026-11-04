"use client";
import Link from "next/link";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import { Card, CardContent, CardDescription, CardHeader, CardTitle } from "@/components/ui/card";
import { Table, TableBody, TableCell, TableHead, TableHeader, TableRow } from "@/components/ui/table";
import { Async } from "@/components/portal/states";
import { PageHeader } from "@/components/portal/parts";
import { useMe } from "@/lib/me-context";
import { useApi } from "@/lib/use-api";

interface Matrix { roles: string[]; areas: string[]; cells: Record<string, Record<string, string>> }
const ROLE_LABEL: Record<string, string> = { owner: "Owner", admin: "Admin", manager: "Manager (region)", dispatcher: "Dispatcher", accountant: "Accountant", driver: "Driver", viewer: "Read-only" };
const tone = (v: string) => v === "-" ? "text-muted-foreground" : v.startsWith("Full") ? "font-medium" : "";

/** Settings: team, roles and the access matrix. The matrix is computed from the permissions the API enforces. */
export default function SettingsPage() {
  const { can } = useMe();
  const m = useApi<Matrix>("/portal/roles-matrix");
  return (
    <>
      <PageHeader title="Team and roles" description="Who can see and do what. Pay and bank details have the tightest rules."
        actions={<>{can("users.manage") && <Button asChild size="sm"><Link href="/settings/users">Manage people and custom roles</Link></Button>}<Button asChild size="sm" variant="outline"><Link href="/settings/teams">Regions and invites</Link></Button></>} />
      <Card>
        <CardHeader><CardTitle>Default role matrix</CardTitle><CardDescription>“Full” means view, add, edit and archive. “View” means read only. A dash means no access. Managers see only the regions (teams) they belong to.</CardDescription></CardHeader>
        <CardContent>
          <Async state={m}>
            {(d) => (
              <div className="overflow-x-auto">
                <Table>
                  <TableHeader><TableRow><TableHead>Area</TableHead>{d.roles.map((r) => <TableHead key={r}>{ROLE_LABEL[r] ?? r}</TableHead>)}</TableRow></TableHeader>
                  <TableBody>{d.areas.map((a) => <TableRow key={a}><TableCell className="font-medium">{a}</TableCell>{d.roles.map((r) => <TableCell key={r} className={tone(d.cells[a]![r]!)}>{d.cells[a]![r]}</TableCell>)}</TableRow>)}</TableBody>
                </Table>
              </div>
            )}
          </Async>
          <p className="mt-3 text-xs text-muted-foreground">Custom roles: <Badge variant="outline">tick permissions one by one</Badge> under Manage people. Drivers use the driver app and see only their own records.</p>
        </CardContent>
      </Card>
    </>
  );
}
