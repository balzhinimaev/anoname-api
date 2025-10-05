import mongoose from 'mongoose';
import Lead from '../models/Lead';
import config from '../config';

async function migrateLeadCampaignFields(): Promise<void> {
  console.log('🚀 Starting migration: populate campaign fields for leads');

  try {
    await mongoose.connect(config.mongoUri, {
      dbName: 'anoname'
    });
    console.log('✅ Connected to MongoDB');

    const now = new Date();

    const updateOperations = [
      {
        description: 'campaign status',
        query: { campaignStatus: { $exists: false } },
        update: { $set: { campaignStatus: 'idle', campaignStatusUpdatedAt: now } }
      },
      {
        description: 'campaign status timestamp',
        query: { campaignStatusUpdatedAt: { $exists: false } },
        update: { $set: { campaignStatusUpdatedAt: now } }
      },
      {
        description: 'campaign id',
        query: { campaignId: { $exists: false } },
        update: { $set: { campaignId: null } }
      },
      {
        description: 'campaign last sent timestamp',
        query: { campaignLastSentAt: { $exists: false } },
        update: { $set: { campaignLastSentAt: null } }
      },
      {
        description: 'campaign last interaction timestamp',
        query: { campaignLastInteractionAt: { $exists: false } },
        update: { $set: { campaignLastInteractionAt: null } }
      }
    ];

    for (const operation of updateOperations) {
      const result = await Lead.updateMany(operation.query, operation.update);
      if (result.matchedCount > 0) {
        console.log(`🔄 Updated ${result.modifiedCount} leads for ${operation.description}`);
      } else {
        console.log(`ℹ️  No leads required update for ${operation.description}`);
      }
    }

    console.log('🧱 Ensuring indexes for campaign fields...');
    await Promise.all([
      Lead.collection.createIndex({ campaignId: 1 }),
      Lead.collection.createIndex({ campaignStatusUpdatedAt: 1 }),
      Lead.collection.createIndex({ campaignLastSentAt: 1 }),
      Lead.collection.createIndex({ campaignLastInteractionAt: 1 })
    ]);
    console.log('✅ Indexes ensured');

    console.log('🎉 Migration completed successfully');
  } catch (error) {
    console.error('❌ Migration failed:', error);
    process.exitCode = 1;
  } finally {
    await mongoose.disconnect();
    console.log('🔌 Disconnected from MongoDB');
    process.exit();
  }
}

migrateLeadCampaignFields();
