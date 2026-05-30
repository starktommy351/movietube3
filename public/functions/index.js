const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Mux = require("@mux/mux-node");

admin.initializeApp();

// 🔐 Mux credentials from Firebase Config (NOT hardcoded!)
const mux = new Mux({
  tokenId: functions.config().mux.token_id,
  tokenSecret: functions.config().mux.token_secret
});

// ✅ Create Mux Upload URL (Auth Protected)
exports.createMuxUpload = functions.https.onRequest(async (req, res) => {
  // CORS Headers
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  res.set('Access-Control-Allow-Headers', 'Content-Type, Authorization');

  if (req.method === 'OPTIONS') {
    return res.status(204).send('');
  }

  if (req.method !== 'POST') {
    return res.status(405).send('POST only');
  }

  try {
    // 🔐 Verify Firebase ID Token
    const authHeader = req.headers.authorization;
    if (!authHeader || !authHeader.startsWith('Bearer ')) {
      return res.status(401).json({ error: 'Unauthorized: No token' });
    }
    
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);
    
    // Optional: Check if user exists in your system
    // const userRecord = await admin.auth().getUser(decodedToken.uid);

    // 🎬 Create Mux Direct Upload
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard',
        passthrough: `uid:${decodedToken.uid}`
      }
    });

    console.log(`Upload created for user ${decodedToken.uid}: ${upload.id}`);
    
    res.json({
      url: upload.url,
      id: upload.id
    });

  } catch (error) {
    console.error('Mux upload error:', error);
    
    if (error.code === 'auth/invalid-id-token') {
      return res.status(401).json({ error: 'Invalid authentication token' });
    }
    
    res.status(500).json({ 
      error: 'Failed to create upload URL',
      details: functions.config().node.env === 'production' ? 'Contact support' : error.message 
    });
  }
});

// 🔄 Optional: Mux Webhook Handler (for real-time status updates)
exports.muxWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');
  
  try {
    const event = req.body;
    
    if (event.type === 'video.asset.ready') {
      const assetId = event.data.id;
      const playbackId = event.data.playback_ids?.[0]?.id;
      
      // Update Firestore: Find video by passthrough or uploadId
      const videosRef = admin.firestore().collection('videos');
      const snapshot = await videosRef.where('muxAssetId', '==', assetId).get();
      
      snapshot.forEach(async (doc) => {
        await doc.ref.update({
          status: 'ready',
          playbackId: playbackId,
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
      });
    }
    
    res.status(200).send('Webhook received');
  } catch (err) {
    console.error('Webhook error:', err);
    res.status(500).send('Webhook failed');
  }
});
