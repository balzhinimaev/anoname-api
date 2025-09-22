 import mongoose from 'mongoose';
import fs from 'fs';
import Lead from '../models/Lead';
import Prelaunch from '../models/Prelaunch';
import config from '../config';

/**
 * Script to migrate leads from user_ids.txt file to Lead collection
 * Adds prelaunched: true field if user exists in Prelaunch collection
 */

interface MigrationStats {
  total: number;
  created: number;
  skipped: number;
  prelaunched: number;
  errors: number;
}

class LeadMigrationService {
  private stats: MigrationStats = {
    total: 0,
    created: 0,
    skipped: 0,
    prelaunched: 0,
    errors: 0
  };

  /**
   * Read user IDs from file
   */
  private readUserIdsFromFile(filePath: string): string[] {
    try {
      const content = fs.readFileSync(filePath, 'utf-8');
      const userIds = content
        .split('\n')
        .map(line => line.trim())
        .filter(line => line.length > 0 && /^\d+$/.test(line)); // Only numeric IDs
      
      console.log(`📁 Found ${userIds.length} valid user IDs in file`);
      return userIds;
    } catch (error) {
      console.error('❌ Error reading file:', error);
      throw error;
    }
  }

  /**
   * Check if user exists in Prelaunch collection
   */
  private async isUserPrelaunched(telegramId: string): Promise<boolean> {
    try {
      const prelaunchUser = await Prelaunch.findOne({ telegramId });
      return !!prelaunchUser;
    } catch (error) {
      console.error(`❌ Error checking prelaunch status for ${telegramId}:`, error);
      return false;
    }
  }

  /**
   * Create lead record
   */
  private async createLead(telegramId: string, isPrelaunched: boolean): Promise<boolean> {
    try {
      const lead = new Lead({
        telegramId,
        createdAt: new Date(),
        isRegistered: false,
        prelaunched: isPrelaunched
      });

      await lead.save();
      return true;
    } catch (error) {
      console.error(`❌ Error creating lead for ${telegramId}:`, error);
      return false;
    }
  }

  /**
   * Process single user ID
   */
  private async processUserId(telegramId: string): Promise<void> {
    try {
      // Check if lead already exists
      const existingLead = await Lead.findOne({ telegramId });
      if (existingLead) {
        console.log(`⏭️  Lead already exists for ${telegramId}, skipping`);
        this.stats.skipped++;
        return;
      }

      // Check if user is in prelaunch
      const isPrelaunched = await this.isUserPrelaunched(telegramId);
      if (isPrelaunched) {
        this.stats.prelaunched++;
      }

      // Create lead
      const created = await this.createLead(telegramId, isPrelaunched);
      if (created) {
        console.log(`✅ Created lead for ${telegramId}${isPrelaunched ? ' (prelaunched)' : ''}`);
        this.stats.created++;
      } else {
        this.stats.errors++;
      }
    } catch (error) {
      console.error(`❌ Error processing ${telegramId}:`, error);
      this.stats.errors++;
    }
  }

  /**
   * Run migration
   */
  async migrate(filePath: string): Promise<void> {
    console.log('🚀 Starting lead migration from file...');
    console.log(`📁 File path: ${filePath}`);

    try {
      // Connect to database
      await mongoose.connect(config.mongoUri, {
        dbName: "anoname"
      });
      console.log('✅ Connected to database');

      // Read user IDs from file
      const userIds = this.readUserIdsFromFile(filePath);
      this.stats.total = userIds.length;

      if (userIds.length === 0) {
        console.log('⚠️  No user IDs found in file');
        return;
      }

      console.log(`📊 Processing ${userIds.length} user IDs...`);

      // Process each user ID
      for (let i = 0; i < userIds.length; i++) {
        const telegramId = userIds[i];
        console.log(`\n[${i + 1}/${userIds.length}] Processing ${telegramId}...`);
        
        await this.processUserId(telegramId);
        
        // Add small delay to avoid overwhelming the database
        // if (i % 100 === 0 && i > 0) {
        //   console.log(`⏸️  Processed ${i} users, taking a short break...`);
        // //   await new Promise(resolve => setTimeout(resolve, 1000));
        // }
      }

      // Print final statistics
      this.printStats();

    } catch (error) {
      console.error('❌ Migration failed:', error);
      throw error;
    } finally {
      // Close database connection
      await mongoose.disconnect();
      console.log('✅ Database connection closed');
    }
  }

  /**
   * Print migration statistics
   */
  private printStats(): void {
    console.log('\n📊 Migration Statistics:');
    console.log('========================');
    console.log(`Total user IDs processed: ${this.stats.total}`);
    console.log(`Leads created: ${this.stats.created}`);
    console.log(`Leads skipped (already exist): ${this.stats.skipped}`);
    console.log(`Prelaunched users: ${this.stats.prelaunched}`);
    console.log(`Errors: ${this.stats.errors}`);
    console.log(`Success rate: ${((this.stats.created / this.stats.total) * 100).toFixed(2)}%`);
  }
}

/**
 * Main execution function
 */
async function main() {
  const filePath = process.argv[2];
  
  if (!filePath) {
    console.error('❌ Please provide file path as argument');
    console.log('Usage: npm run migrate-leads <path-to-user_ids.txt>');
    console.log('Example: npm run migrate-leads ./user_ids.txt');
    process.exit(1);
  }

  // Check if file exists
  if (!fs.existsSync(filePath)) {
    console.error(`❌ File not found: ${filePath}`);
    process.exit(1);
  }

  const migrationService = new LeadMigrationService();
  
  try {
    await migrationService.migrate(filePath);
    console.log('\n🎉 Migration completed successfully!');
  } catch (error) {
    console.error('\n💥 Migration failed:', error);
    process.exit(1);
  }
}

// Run if this file is executed directly
if (require.main === module) {
  main();
}

export default LeadMigrationService;
