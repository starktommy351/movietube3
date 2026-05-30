const functions = require("firebase-functions");
const admin = require("firebase-admin");
const Mux = require("@mux/mux-node");

admin.initializeApp();

const mux = new Mux({
  tokenId: process.env.MUX_TOKEN_ID,
  tokenSecret: process.env.MUX_TOKEN_SECRET
});

// ১. আপলোড URL তৈরি (passthrough এ upload.id পাঠানো হচ্ছে)
exports.createMuxUpload = functions.https.onRequest(async (req, res) => {
  res.set('Access-Control-Allow-Origin', '*');
  res.set('Access-Control-Allow-Methods', 'POST');
  
  if (req.method === 'OPTIONS') return res.status(204).send('');

  try {
    // Auth চেক
    const authHeader = req.headers.authorization;
    if (!authHeader?.startsWith('Bearer ')) return res.status(401).json({ error: 'Unauthorized' });
    
    const idToken = authHeader.split('Bearer ')[1];
    const decodedToken = await admin.auth().verifyIdToken(idToken);

    // Mux Upload তৈরি
    const upload = await mux.video.uploads.create({
      new_asset_settings: {
        playback_policy: ['public'],
        mp4_support: 'standard',
        // 🔑 গুরুত্বপূর্ণ: upload.id কে passthrough এ পাঠানো হচ্ছে যাতে Webhook চিনতে পারে
        passthrough: upload.id || "upload-" + Date.now() 
      }
    });

    // Firestore এ ডাটা সেভ করা
    await admin.firestore().collection('videos').add({
      uploadId: upload.id,
      userId: decodedToken.uid,
      status: 'uploading',
      createdAt: admin.firestore.FieldValue.serverTimestamp(),
      isPublic: true
    });

    res.json({ url: upload.url, id: upload.id });

  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// ২. Webhook Handler (Mux থেকে ডাটা রিসিভ করা)
exports.muxWebhook = functions.https.onRequest(async (req, res) => {
  if (req.method !== 'POST') return res.status(405).send('POST only');

  try {
    const event = req.body;
    console.log("Webhook received:", event.type);

    // যদি ভিডিও প্রসেসিং শেষ হয়ে ready হয়
    if (event.type === 'video.asset.ready') {
      const assetData = event.data;
      const playbackId = assetData.playback_ids?.[0]?.id;
      
      // 🔑 এখানে আমরা passthrough (যা আগে upload.id ছিল) দিয়ে Firestore এ সার্চ করছি
      // Mux এর asset payload এ passthrough ডাটা থাকে যদি upload করার সময় পাঠানো হয়েছিল
      const passthrough = assetData.passthrough; 

      if (!passthrough) return res.status(200).send('No passthrough data');

      // Firestore এ সেই ভিডিওটি খুঁজে বের করা
      const videosRef = admin.firestore().collection('videos');
      const snapshot = await videosRef.where('uploadId', '==', passthrough).get();

      snapshot.forEach(async (doc) => {
        await doc.ref.update({
          muxAssetId: assetData.id,
          playbackId: playbackId,
          status: 'ready',
          updatedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        console.log(`Updated video ${doc.id} to ready`);
      });
    }

    res.status(200).send('Webhook processed');
  } catch (err) {
    console.error(err);
    res.status(500).send('Webhook error');
  }
});
