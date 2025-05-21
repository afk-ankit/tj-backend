export type GHLWorkflowData = {
  PropertyAddress: string;
  MailingZip: string;
  MailingState: string;
  MailingAddress: string;
  PhoneType: string;
  MailingCity: string;
  PropertyState: string;
  PropertyCity: string;
  PropertyZip: string;
  contact_id: string;
  first_name: string;
  last_name: string;
  full_name: string;
  phone: string;
  tags: string;
  country: string;
  date_created: string; // ISO date string
  full_address: string;
  contact_type: string;
  location: {
    name: string;
    address: string;
    city: string;
    state: string;
    country: string;
    postalCode: string;
    fullAddress: string;
    id: string;
  };
  workflow: {
    id: string;
    name: string;
  };
  triggerData: Record<string, any>;
  customData: Record<string, any>;
};
