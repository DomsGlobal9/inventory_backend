import { seedRolesForClient } from '../services/rbac-seed.service';
async function main() {
  const roleIds = await seedRolesForClient('demo-client');
  console.log('reseeded', JSON.stringify(roleIds));
}
main().then(() => process.exit(0)).catch(e => { console.error('ERR', e); process.exit(1); });
