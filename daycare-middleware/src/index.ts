import * as semver from "semver";

import type { 
  IPluginMiddleware,
  Config,
  IBasicAuth,
  Logger
} from '@verdaccio/types';
import { Request, Response, NextFunction } from 'express';

interface CustomConfig extends Config {
  minWeeklyDownloads: number;
  minAgeHours: number;
}


export default class DaycareMiddleware implements IPluginMiddleware<CustomConfig> {
  private readonly minWeeklyDownloads: number;
  private readonly minAgeHours: number;
  private readonly allowlistPackages: Set<string>;
  private readonly allowManualOverride: boolean;
  private readonly logger: Logger;

  constructor(config: CustomConfig, options: { logger: Logger }) {
    this.minWeeklyDownloads = process.env.MIN_WEEKLY_DOWNLOADS ? parseInt(process.env.MIN_WEEKLY_DOWNLOADS) : config.minWeeklyDownloads;
    this.minAgeHours = process.env.MIN_AGE_HOURS ? parseInt(process.env.MIN_AGE_HOURS) : config.minAgeHours;
    this.allowlistPackages = new Set();
    this.allowManualOverride = true;
    this.logger = options.logger;
    this.logger.info(`starting daycare middleware with minWeeklyDownloads: ${this.minWeeklyDownloads} and minAgeHours: ${this.minAgeHours}`);
  }

  private async getWeeklyDownloads(packageName: string): Promise<number> {
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
      
      this.logger.debug(`${packageName}: ${downloads} weekly downloads`);
      return downloads;
    } catch (error) {
      this.logger.warn(`Failed to get download stats for ${packageName}: ${String(error)}`);
      // On error, assume it meets the threshold to avoid blocking legitimate packages
      return this.minWeeklyDownloads;
    }
  }

  

  private isVersionOldEnough(publishTimeIso: string): boolean {
    if (!publishTimeIso) return false;
    const HOUR_MS = 1000 * 60 * 60;
    const now = Date.now();
    const publishedAt = new Date(publishTimeIso).getTime();
    const ageHours = (now - publishedAt) / HOUR_MS;
    return ageHours > this.minAgeHours;
  }

  private filterPackageMetadata(packageInfo: any): any {
    const { versions, time, 'dist-tags': distTags } = packageInfo || {};
    if (!time || !versions) {
      return packageInfo;
    }

    const allowedVersions: Record<string, any> = {};
    const allowedVersionsList: string[] = [];

    Object.keys(versions).forEach(version => {
      const publishTime = time[version];
      if (!publishTime) return;
      if (this.isVersionOldEnough(publishTime)) {
        allowedVersions[version] = versions[version];
        allowedVersionsList.push(version);
      }
    });

    // Filter dist-tags to only include allowed versions
    const filteredDistTags: Record<string, string> = {};
    if (distTags) {
      Object.entries(distTags as Record<string, string>).forEach(([tag, version]) => {
        const versionString = version as string;
        if (allowedVersionsList.includes(versionString)) {
          filteredDistTags[tag] = versionString;
        }
      });
    }

    // If no allowed versions, return minimal package structure
    if (allowedVersionsList.length === 0) {
      return {
        ...packageInfo,
        versions: {},
        'dist-tags': {},
        time: time && {
          created: time.created,
          modified: time.modified,
        }
      };
    }

    // If latest tag was filtered out, set it to the newest allowed version
    if (distTags?.latest && !filteredDistTags.latest && allowedVersionsList.length > 0) {
      // Sort versions by publish time (newest first)
      const sortedVersions = semver.sort(allowedVersionsList);
      filteredDistTags.latest = sortedVersions[sortedVersions.length - 1];
      this.logger.info(`Set latest tag to ${sortedVersions[sortedVersions.length - 1]} (newest allowed version)`);
    }

    // Filter the time object to match allowed versions (and keep created/modified)
    const filteredTime: Record<string, string> = {};
    if (time) {
      if (time.created) filteredTime.created = time.created;
      if (time.modified) filteredTime.modified = time.modified;
      allowedVersionsList.forEach(version => {
        if (time[version]) filteredTime[version] = time[version];
      });
    }

    return {
      ...packageInfo,
      versions: allowedVersions,
      'dist-tags': filteredDistTags,
      time: filteredTime,
    };
  }

  private async fetchPackageMetadata(packageName: string): Promise<any | null> {
    try {
      const url = `https://registry.npmjs.org/${encodeURIComponent(packageName)}`;
      const response = await fetch(url);
      if (!response.ok) {
        this.logger.debug(`Upstream metadata fetch failed for ${packageName} (HTTP ${response.status})`);
        return null;
      }
      return await response.json();
    } catch (error) {
      this.logger.warn(`Failed to fetch metadata for ${packageName}: ${String(error)}`);
      return null;
    }
  }

  private async handleMetadataRequest(packageName: string, res: Response, next: NextFunction): Promise<void> {
    try {
      // Allow manual override / explicit allowlist
      if (this.isPackageAllowlisted(packageName)) {
        this.logger.debug(`Allowlisted metadata passthrough for ${packageName}`);
        return next();
      }

      const weeklyDownloads = await this.getWeeklyDownloads(packageName);
      if (weeklyDownloads < this.minWeeklyDownloads) {
        this.logger.info(`Blocking metadata for ${packageName}: ${weeklyDownloads} weekly downloads (min: ${this.minWeeklyDownloads})`);
        res.status(200).json({ name: packageName, versions: {}, 'dist-tags': {} });
        return;
      }

      const upstream = await this.fetchPackageMetadata(packageName);
      if (!upstream) {
        // Fall back to Verdaccio's normal handling
        return next();
      }

      const filtered = this.filterPackageMetadata(upstream);
      res.status(200).json(filtered);
    } catch (error) {
      this.logger.error(`Error handling metadata for ${packageName}: ${String(error)}`);
      return next();
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
      this.logger.error(`Error checking version ${packageName}@${version}: ${String(error)}`);
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

    // Intercept and filter metadata responses
    app.get('/:package', async (req: Request, res: Response, next: NextFunction) => {
      const packageName = req.params.package;
      this.logger.debug(`Metadata request for: ${packageName}`);
      await this.handleMetadataRequest(packageName, res, next);
    });

    app.get('/:scope/:package', async (req: Request, res: Response, next: NextFunction) => {
      const packageName = `${req.params.scope}/${req.params.package}`;
      this.logger.debug(`Scoped metadata request for: ${packageName}`);
      await this.handleMetadataRequest(packageName, res, next);
    });
  }
}