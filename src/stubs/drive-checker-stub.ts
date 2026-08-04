export interface DriveCheckResult {
  folderFound: boolean;
  filesFound: string[];
  lastModified?: Date;
}

export interface IDriveChecker {
  checkFolderSubmission(folderUrlOrId: string, afterDate: Date): Promise<DriveCheckResult>;
}

/**
 * Google Drive Folder Checker Stub
 * Prepared for future integration without breaking core pipeline logic.
 */
export class GoogleDriveCheckerStub implements IDriveChecker {
  public async checkFolderSubmission(
    folderUrlOrId: string,
    afterDate: Date
  ): Promise<DriveCheckResult> {
    // Stub implementation for v1
    return {
      folderFound: false,
      filesFound: [],
    };
  }
}
