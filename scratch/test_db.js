const GalleryDB = require('../db-manager');
(async () => {
  try {
    const db = new GalleryDB('test_init.db');
    await db.init();
    console.log('Init success');
    const stats = await db.get('SELECT COUNT(*) as count FROM posts');
    console.log('Stats:', stats);
  } catch (e) {
    console.error('Init failed:', e);
  }
})();
