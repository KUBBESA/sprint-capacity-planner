import { defineFunction } from '@aws-amplify/backend';

export const api = defineFunction({
  name: 'sprint-capacity-api',
  entry: './handler.mjs',
  environment: {
    CLIENT_ID: 'gNPOSwQUPEuTuZ8p0R4dqBuO9EbPSr2F',
    CLIENT_SECRET: 'ATOAu8J9EqhitezPnE8kHttPW0_s0J5RiKIqrmyg__rNAjy7BKemkuW5HPR41K-LvWdvC21871F4',
    SITE_URL: 'https://team-crediviva.atlassian.net',
    APP_ORIGIN: 'https://d2ebvw4qesirqr.amplifyapp.com',
    SESSIONS_TABLE: 'sprint-capacity-planner-SessionsTable-XGKJC2DBZPC6',
    PLANNER_TABLE: 'sprint-capacity-planner-PlannerTable-1JXVA90C9WGV3',
    PERSONAL_DATA_TABLE: 'sprint-capacity-planner-PersonalDataTable-ZHU2G23LK8GV',
  },
  timeoutSeconds: 30,
  memoryMB: 512,
});
