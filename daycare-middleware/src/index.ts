import type { 
  IPluginMiddleware,
  Config,
  IBasicAuth,
  Logger
} from '@verdaccio/types';
import { Request, Response, NextFunction } from 'express';

interface CustomConfig extends Config {
  minWeeklyDownloads: number;
}


export default class DaycareMiddleware implements IPluginMiddleware<CustomConfig> {
  private readonly minWeeklyDownloads: number;
  private readonly allowlistPackages: Set<string>;
  private readonly allowManualOverride: boolean;
  private readonly logger: Logger;
  private downloadCache: Map<string, { downloads: number, timestamp: number }> = new Map();
  private readonly CACHE_TTL = 5 * 60 * 1000; // 5 minutes cache

  constructor(config: CustomConfig, options: { logger: Logger }) {
    this.minWeeklyDownloads = process.env.MIN_WEEKLY_DOWNLOADS ? parseInt(process.env.MIN_WEEKLY_DOWNLOADS) : config.minWeeklyDownloads;
    this.allowlistPackages = new Set();
    this.allowManualOverride = true;
    this.logger = options.logger;
    this.logger.info(`starting daycare middleware with minWeeklyDownloads: ${this.minWeeklyDownloads}`);
  }

  private async getWeeklyDownloads(packageName: string): Promise<number> {
    // Check cache first
    const cached = this.downloadCache.get(packageName);
    if (cached && Date.now() - cached.timestamp < this.CACHE_TTL) {
      return cached.downloads;
    }

    try {
      // Use npm registry API to get download stats
      const url = `https://api.npmjs.org/downloads/point/last-week/${encodeURIComponent(packageName)}`;
      const response = await fetch(url);
      
      if (!response.ok) {
        if (response.status === 404) {
          this.logger.debug(`No download stats found for ${packageName}`);
          return 0;
        }
        throw new Error(`HTTP ${response.status}`);
      }

      const data = await response.json();
      const downloads = data.downloads || 0;
      
      // Cache the result
      this.downloadCache.set(packageName, {
        downloads,
        timestamp: Date.now()
      });
      
      this.logger.debug(`${packageName}: ${downloads} weekly downloads`);
      return downloads;
    } catch (error) {
      this.logger.warn(`Failed to get download stats for ${packageName}:`, error as string);
      // On error, assume it meets the threshold to avoid blocking legitimate packages
      return this.minWeeklyDownloads;
    }
  }

  private isPackageAllowlisted(packageName: string): boolean {
    // Handle @force: prefix
    const actualPackageName = this.allowManualOverride && packageName.startsWith('@force:') 
      ? packageName.substring(7) // Remove '@force:' prefix
      : packageName;
    
    // Check if package is explicitly allowlisted
    if (this.allowlistPackages.has(actualPackageName)) {
      return true;
    }
    
    // Check for manual override prefix
    if (this.allowManualOverride && packageName.startsWith('@force:')) {
      this.logger.info(`Manual override detected for ${packageName}`);
      return true;
    }
    
    return false;
  }

  private async shouldBlockVersion(packageName: string, version: string): Promise<boolean> {
    try {
      // Check if package is allowlisted first
      if (this.isPackageAllowlisted(packageName)) {
        this.logger.debug(`Package ${packageName} is allowlisted, allowing tarball`);
        return false;
      }

      // Check download threshold
      const weeklyDownloads = await this.getWeeklyDownloads(packageName);
      if (weeklyDownloads < this.minWeeklyDownloads) {
        this.logger.info(`Blocking ${packageName}@${version}: ${weeklyDownloads} weekly downloads (min: ${this.minWeeklyDownloads})`);
        return true;
      }

      // For age checking, we'd need package metadata here
      // This is a simplified version - you could enhance it by fetching metadata
      this.logger.debug(`Allowing tarball ${packageName}@${version} (${weeklyDownloads} weekly downloads)`);
      return false;
    } catch (error) {
      this.logger.error(`Error checking version ${packageName}@${version}:`, error as string);
      return false; // Don't block on error
    }
  }

  // Middleware to block tarball downloads for disallowed versions
  register_middlewares(app: any, auth: IBasicAuth<CustomConfig>): void {
    // Intercept tarball requests for regular packages
    app.get('/:package/-/:filename', async (req: Request, res: Response, next: NextFunction) => {
      const packageName = req.params.package;
      const filename = req.params.filename;
      
      this.logger.debug(`Tarball request: ${packageName}/${filename}`);
      
      // Extract version from filename (e.g., "node-24.5.0.tgz" -> "24.5.0")
      const versionMatch = filename.match(/^.*?-(\d+(?:\.\d+)*(?:-[^.]+)*(?:\+[^.]+)*)\.tgz$/);
      if (versionMatch) {
        const version = versionMatch[1];
        this.logger.debug(`Checking tarball access for ${packageName}@${version}`);
        
        // Check if this version should be blocked
        if (await this.shouldBlockVersion(packageName, version)) {
          this.logger.warn(`BLOCKING tarball download: ${packageName}@${version}`);
          res.status(404).json({ 
            error: 'Version not found',
            reason: `Version ${version} is blocked by quarantine filter`
          });
          return;
        }
      }
      
      next();
    });

    // Intercept tarball requests for scoped packages  
    app.get('/:scope/:package/-/:filename', async (req: Request, res: Response, next: NextFunction) => {
      const packageName = `${req.params.scope}/${req.params.package}`;
      const filename = req.params.filename;
      
      this.logger.debug(`Scoped tarball request: ${packageName}/${filename}`);
      
      const versionMatch = filename.match(/^.*?-(\d+(?:\.\d+)*(?:-[^.]+)*(?:\+[^.]+)*)\.tgz$/);
      if (versionMatch) {
        const version = versionMatch[1];
        this.logger.debug(`Checking scoped tarball access for ${packageName}@${version}`);
        
        if (await this.shouldBlockVersion(packageName, version)) {
          this.logger.warn(`BLOCKING scoped tarball download: ${packageName}@${version}`);
          res.status(404).json({ 
            error: 'Version not found',
            reason: `Version ${version} is blocked by quarantine filter`
          });
          return;
        }
      }
      
      next();
    });

    // Optional: Log all package requests for debugging
    app.get('/:package', (req: Request, res: Response, next: NextFunction) => {
      const packageName = req.params.package;
      this.logger.debug(`Metadata request for: ${packageName}`);
      next();
    });

    app.get('/:scope/:package', (req: Request, res: Response, next: NextFunction) => {
      const packageName = `${req.params.scope}/${req.params.package}`;
      this.logger.debug(`Scoped metadata request for: ${packageName}`);
      next();
    });
  }
}