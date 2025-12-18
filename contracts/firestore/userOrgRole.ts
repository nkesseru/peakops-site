export type OrgRole =
  | "ADMIN"
  | "SUPERVISOR"
  | "OPERATOR"
  | "AUDITOR"
  | "VIEWER";

export interface OrgMembership {
  orgId: string;
  role: OrgRole;
  active: boolean;
  createdAt: string; // ISO
}

export interface UserProfile {
  id: string; // uid
  email: string;
  displayName?: string;

  memberships: OrgMembership[];

  createdAt: string; // ISO
  updatedAt: string; // ISO
}
