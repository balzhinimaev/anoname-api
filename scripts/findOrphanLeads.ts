import mongoose from 'mongoose';
import Lead from '../src/models/Lead';
import User from '../src/models/User';
import Prelaunch from '../src/models/Prelaunch';
import fs from 'fs';
import path from 'path';
import dotenv from "dotenv";
dotenv.config();

/**
 * Script to find leads that are not registered as users and not in prelaunch
 * Outputs telegram IDs to a text file
 */

async function findOrphanLeads() {
  try {
    // Connect to MongoDB
    const mongoUri = process.env.MONGODB_URI || 'mongodb://localhost:27017/telegram-dating';
    await mongoose.connect(mongoUri, {
        dbName: "anoname"
    });
    console.log('Connected to MongoDB');

    // Get all leads
    const allLeads = await Lead.find({}).lean();
    console.log(`Found ${allLeads.length} total leads`);

    // Get all registered user telegram IDs
    const registeredUserIds = await User.find({}, 'telegramId').lean();
    const registeredTelegramIds = new Set(registeredUserIds.map(user => String(user.telegramId)));
    console.log(`Found ${registeredTelegramIds.size} registered users`);

    // Get all prelaunch user IDs
    const prelaunchUsers = await Prelaunch.find({}, 'userId').lean();
    const prelaunchUserIds = new Set(prelaunchUsers.map(p => p.userId.toString()));
    console.log(`Found ${prelaunchUserIds.size} prelaunch users`);

    // Get user IDs for prelaunch users to check their telegram IDs
    const prelaunchUserDetails = await User.find(
      { _id: { $in: prelaunchUsers.map(p => p.userId) } },
      'telegramId'
    ).lean();
    const prelaunchTelegramIds = new Set(prelaunchUserDetails.map(user => String(user.telegramId)));
    console.log(`Found ${prelaunchTelegramIds.size} prelaunch telegram IDs`);

    // Find orphan leads (not in users and not in prelaunch)
    const orphanLeads: string[] = [];
    
    for (const lead of allLeads) {
      const isRegistered = registeredTelegramIds.has(lead.telegramId);
      const isInPrelaunch = prelaunchTelegramIds.has(lead.telegramId);
      
      if (!isRegistered && !isInPrelaunch) {
        orphanLeads.push(lead.telegramId);
      }
    }

    console.log(`Found ${orphanLeads.length} orphan leads`);

    // Write to file
    const outputPath = path.join(__dirname, '..', 'orphan_leads.txt');
    const content = orphanLeads.join('\n');
    fs.writeFileSync(outputPath, content, 'utf8');

    console.log(`Orphan leads written to: ${outputPath}`);
    console.log('Orphan leads:');
    orphanLeads.forEach((id) => {
      console.log(id);
    });

  } catch (error) {
    console.error('Error:', error);
  } finally {
    await mongoose.disconnect();
    console.log('Disconnected from MongoDB');
  }
}

// Run the script
if (require.main === module) {
  findOrphanLeads().catch(console.error);
}

export { findOrphanLeads };
