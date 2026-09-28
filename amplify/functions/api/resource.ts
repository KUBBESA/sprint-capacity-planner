import { defineFunction } from '@aws-amplify/backend';

export const api = defineFunction({
  name: 'sprint-capacity-api',
  entry: './amplify/functions/api/handler.ts',
  environment: {
    CLIENT_ID: 'gNPOSwQUPEuTuZ8p0R4dqBuO9EbPSr2F',
    SESSIONS_TABLE: 'sprint-capacity-planner-SessionsTable',
    PLANNER_TABLE: 'sprint-capacity-planner-PlannerTable',
    PERSONAL_DATA_TABLE: 'sprint-capacity-planner-PersonalDataTable',
  },
  timeoutSeconds: 30,
  memoryMB: 512,
});
