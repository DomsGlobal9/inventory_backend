const { PrismaClient, Prisma } = require('@prisma/client');
const prisma = new PrismaClient();

const data = [
  // ── SIZES ──
  ...[['XS',0],['S',1],['M',2],['L',3],['XL',4],['XXL',5]].map(([v,i]) => ({
    type:'SIZE', value:v, label:v, sortOrder:i
  })),

  // ── CATEGORIES ──
  { type: 'CATEGORY', value: 'WOMEN', label: 'Women', sortOrder: 0 },
  { type: 'CATEGORY', value: 'MEN',   label: 'Men',   sortOrder: 1 },
  { type: 'CATEGORY', value: 'KIDS',  label: 'Kids',  sortOrder: 2 },

  // ── PRODUCT TYPES ──
  { type:'PRODUCT_TYPE', value:'READY_TO_WEAR', label:'Ready to Wear', sortOrder:0 },
  { type: 'PRODUCT_TYPE', value: 'UNSTITCHED', label: 'Unstitched', sortOrder: 1 },

  // ── DRESS TYPES: WOMEN ──
  ...['Saree','Lehenga','Anarkalis','Shararas','Wedding','Salwar Suit Sets (Top, Bottom & Dupatta)','Kurta-Sets']
    .map((v,i) => ({ type:'DRESS_TYPE', value:v, label:v, category:'WOMEN', sortOrder:i })),

  // ── DRESS TYPES: MEN ──
  ...['Kurta Pajama','Sherwani','Nehru Jacket','Shirts','T-Shirts','Trousers']
    .map((v,i) => ({ type:'DRESS_TYPE', value:v, label:v, category:'MEN', sortOrder:i })),

  // ── DRESS TYPES: KIDS ──
  ...['Lehenga Choli','Kurta Pajama','Dresses','Sets']
    .map((v,i) => ({ type:'DRESS_TYPE', value:v, label:v, category:'KIDS', sortOrder:i })),

  // ── MATERIALS ──
  ...['Cotton','Silk','Silk Cotton','Georgette','Chiffon','Net','Velvet','Crepe','Khadi','Tissue','Pure Linen','Kota','Viscose','Mulmul','Organza']
    .map((v,i) => ({ type:'MATERIAL', value:v, label:v, sortOrder:i })),

  // ── DESIGN TYPES ──
  ...['Embroidered','Ajrakh','Block Printed','Batik','Sanganeri','Woven','Printed','Plain','Sequined','Beaded','Mirror Work','Dabu','Shibori','Mukasish','Brocade','Cutout','Ikat','Chikankari']
    .map((v,i) => ({ type:'DESIGN_TYPE', value:v, label:v, sortOrder:i })),

  // ── COLORS ──
  {
    type:'COLOR', value:'red', label:'Red', sortOrder:0,
    metadata: { hex:'#FF0000', shades:['#8B0000','#B22222','#DC143C','#FF0000','#FF4500','#FF6347','#FF7F7F','#FFB6B6'] }
  },
  {
    type:'COLOR', value:'pink', label:'Pink', sortOrder:1,
    metadata: { hex:'#FF69B4', shades:['#C71585','#DB7093','#FF1493','#FF69B4','#FFB6C1','#FFC0CB','#FFD6E7'] }
  },
  {
    type:'COLOR', value:'blue', label:'Blue', sortOrder:2,
    metadata: { hex:'#0000FF', shades:['#00008B','#0000CD','#1E90FF','#4169E1','#4682B4','#87CEEB','#B0E0E6'] }
  },
  {
    type:'COLOR', value:'green', label:'Green', sortOrder:3,
    metadata: { hex:'#008000', shades:['#006400','#228B22','#008000','#32CD32','#00FF7F','#90EE90','#C1E1C1'] }
  },
  {
    type:'COLOR', value:'orange', label:'Orange', sortOrder:4,
    metadata: { hex:'#FFA500', shades:['#FF8C00','#FF7F50','#FF6347','#FFA500','#FFA07A','#FFDAB9','#FFE4B5','#FFF5E1'] }
  },
  {
    type:'COLOR', value:'purple', label:'Purple', sortOrder:5,
    metadata: { hex:'#800080', shades:['#4B0082','#6A0DAD','#800080','#8A2BE2','#9370DB','#BA55D3','#D8BFD8','#E6E6FA'] }
  },
  {
    type:'COLOR', value:'black', label:'Black', sortOrder:6,
    metadata: { hex:'#000000', shades:['#000000','#2F2F2F','#555555','#808080','#A9A9A9','#C0C0C0','#E0E0E0','#F5F5F5'] }
  },
  {
    type:'COLOR', value:'white', label:'White', sortOrder:7,
    metadata: { hex:'#FFFFFF', shades:['#FFFFFF','#F5F5F5','#ECECEC','#E0E0E0'] }
  },
  {
    type:'COLOR', value:'yellow', label:'Yellow', sortOrder:8,
    metadata: { hex:'#FFD700', shades:['#B8860B','#DAA520','#FFD700','#FFEC8B','#FFFACD'] }
  },
  {
    type:'COLOR', value:'gold', label:'Gold', sortOrder:9,
    metadata: { hex:'#C5A028', shades:['#8B7536','#A08030','#C5A028','#D4B840','#E8D070'] }
  },
];

async function main() {
  console.log(`Seeding ${data.length} catalog config entries...`);

  // 1. Create Default Template
  const defaultTemplate = await prisma.catalogTemplate.upsert({
    where: { name: 'Default' },
    update: {},
    create: {
      name: 'Default',
      description: 'Standard catalog configuration',
    }
  });

  console.log(`✅ Default template created (ID: ${defaultTemplate.id})`);

  // 2. Insert items into CatalogTemplateItem
  const templateItems = await prisma.catalogTemplateItem.createMany({
    data: data.map(entry => ({
      templateId: defaultTemplate.id,
      type: entry.type,
      value: entry.value,
      label: entry.label,
      category: entry.category ?? null,
      metadata: entry.metadata ?? null,
      sortOrder: entry.sortOrder ?? 0,
    })),
    skipDuplicates: true,
  });

  console.log(`✅ ${templateItems.count} items inserted into template.`);

  // 3. Bootstrap demo-client
  const DEMO_CLIENT_ID = 'demo-client';
  
  // Get all template items
  const allTemplateItems = await prisma.catalogTemplateItem.findMany({
    where: { templateId: defaultTemplate.id }
  });

  // Insert into client_catalog_items
  const clientItems = await prisma.clientCatalogItem.createMany({
    data: allTemplateItems.map(item => ({
      clientId: DEMO_CLIENT_ID,
      type: item.type,
      value: item.value,
      label: item.label,
      category: item.category,
      metadata: item.metadata,
      sortOrder: item.sortOrder,
      isSystem: true,
    })),
    skipDuplicates: true,
  });

  console.log(`✅ ${clientItems.count} items cloned to ${DEMO_CLIENT_ID} catalog.`);
}

main().catch(console.error).finally(() => prisma.$disconnect());
