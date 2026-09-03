const fs = require('fs');
const path = require('path');

const routesDir = path.join(__dirname, '..', 'routes');
const files = fs.readdirSync(routesDir).filter(f => f.endsWith('.ts'));

files.forEach(file => {
  const filePath = path.join(routesDir, file);
  let content = fs.readFileSync(filePath, 'utf8');
  
  if (file === 'auth.routes.ts') {
    content = content.replace(/requireAuth/g, 'authenticate');
  } else if (file !== 'api.routes.ts') {
    // Remove the import and the router.use(requireAuth);
    content = content.replace(/import \{ requireAuth \} from '\.\.\/middleware\/auth\.middleware';\r?\n/g, '');
    content = content.replace(/router\.use\(requireAuth\);\r?\n/g, '');
    content = content.replace(/returnsRoutes\.use\(requireAuth\);\r?\n/g, '');
  }
  
  fs.writeFileSync(filePath, content);
});

console.log('Cleaned up requireAuth');
