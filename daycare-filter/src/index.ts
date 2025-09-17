import type {
  IPluginStorageFilter,
  Package,
  Config,
  Logger
} from '@verdaccio/types';

interface CustomConfig extends Config {
  minAgeHours: number;
  minWeeklyDownloads: number;
}

const HOUR_MS = 1000 * 60 * 60;

export default class DaycareFilter implements IPluginStorageFilter<CustomConfig> {
  private readonly minAgeHours: number;
  private readonly minWeeklyDownloads: number;
  private readonly logger: Logger;

  constructor(config: CustomConfig, options: { logger: Logger }) {
    this.minAgeHours = process.env.MIN_AGE_HOURS ? parseInt(process.env.MIN_AGE_HOURS) : config.minAgeHours;
    this.minWeeklyDownloads = process.env.MIN_WEEKLY_DOWNLOADS ? parseInt(process.env.MIN_WEEKLY_DOWNLOADS) : config.minWeeklyDownloads;
    this.logger = options.logger;
    this.logger.info(`starting daycare filter with minAgeHours: ${this.minAgeHours} and minWeeklyDownloads: ${this.minWeeklyDownloads}`);
  }

  private filterPackageMetadata(packageInfo: Package): Package {
    const { versions, time, 'dist-tags': distTags } = packageInfo;
    const now = Date.now();

    if (!time) {
      this.logger.warn('Publish time is not found');
      return packageInfo;
    }

    const allowedVersions: Record<string, any> = {};
    const allowedVersionsList: string[] = [];

    Object.keys(versions || {}).forEach(version => {
      const publishTime = time[version];
      if (!publishTime) {
        this.logger.warn(`No publish time found for version ${version}`);
        return;
      }

      const publishedAt = new Date(publishTime).getTime();
      const ageHours = (now - publishedAt) / HOUR_MS;

      if (ageHours > this.minAgeHours) {
        allowedVersions[version] = versions[version];
        allowedVersionsList.push(version);
        this.logger.debug(`Allowing version ${version} (${ageHours.toFixed(1)}h old, published: ${publishTime})`);
      } else {
        this.logger.info(`Blocking version ${version} (${ageHours.toFixed(1)}h old, min: ${this.minAgeHours}h, published: ${publishTime})`);
      }
    });

    // Filter dist-tags to only include allowed versions
    const filteredDistTags: Record<string, string> = {};
    if (distTags) {
      Object.entries(distTags).forEach(([tag, version]) => {
        if (allowedVersionsList.includes(version)) {
          filteredDistTags[tag] = version;
        } else {
          this.logger.debug(`Removing dist-tag ${tag}:${version} (version not allowed)`);
        }
      });
    }

    // If no allowed versions, return minimal package structure
    if (allowedVersionsList.length === 0) {
      this.logger.info(`No versions meet age requirements for package ${packageInfo.name}`);
      return {
        ...packageInfo,
        versions: {},
        'dist-tags': {},
      };
    }

    // If latest tag was filtered out, set it to the newest allowed version
    if (distTags?.latest && !filteredDistTags.latest && allowedVersionsList.length > 0) {
      // Sort versions by publish time (newest first)
      const sortedVersions = allowedVersionsList.sort((a, b) => {
        const aTime = new Date(time[a]).getTime();
        const bTime = new Date(time[b]).getTime();
        return bTime - aTime;
      });
      filteredDistTags.latest = sortedVersions[0];
      this.logger.info(`Set latest tag to ${sortedVersions[0]} (newest allowed version)`);
    }

    // Also filter the time object to match allowed versions
    const filteredTime: Record<string, string> = {};
    if (time) {
      // Always include the package creation time
      if (time.created) {
        filteredTime.created = time.created;
      }
      if (time.modified) {
        filteredTime.modified = time.modified;
      }

      // Only include times for allowed versions
      allowedVersionsList.forEach(version => {
        if (time[version]) {
          filteredTime[version] = time[version];
        }
      });
    }

    const result = {
      ...packageInfo,
      versions: allowedVersions,
      'dist-tags': filteredDistTags,
      time: filteredTime,
    };

    this.logger.info(`Filtered ${packageInfo.name}: ${allowedVersionsList.length}/${Object.keys(versions || {}).length} versions allowed`);
    return result;
  }

  private async getWeeklyDownloads(packageName: string): Promise<number> {
    try {
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
      this.logger.warn(`Failed to get download stats for ${packageName}:`, error as string);
      return this.minWeeklyDownloads;
    }
  }

  async filter_metadata(packageInfo: Readonly<Package>): Promise<Package> {
    this.logger.debug(`Storage filter for ${packageInfo.name}`);
    const weeklyDownloads = await this.getWeeklyDownloads(packageInfo.name);
    if (weeklyDownloads < this.minWeeklyDownloads) {
      this.logger.info(`Blocking ${packageInfo.name} (weekly downloads: ${weeklyDownloads}, min: ${this.minWeeklyDownloads})`);
      return {
        ...packageInfo,
        versions: {},
        'dist-tags': {},
      };
    }
    const filtered = this.filterPackageMetadata(packageInfo as Package);
    return filtered;
  }
}