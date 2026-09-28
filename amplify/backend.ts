import { defineBackend } from '@aws-amplify/backend';
import { auth } from './auth/resource.js';
import { api } from './functions/api/resource.js';

defineBackend({
  auth,
  api,
});
