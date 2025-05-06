export type InstallEvent = {
  type: 'INSTALL';
  appId: string;
  installType: 'Location' | 'Company';
  locationId?: string;
  companyId: string;
  userId: string;
  planId: string;
  trial: Record<string, unknown>;
  timestamp: string;
  webhookId: string;
};
