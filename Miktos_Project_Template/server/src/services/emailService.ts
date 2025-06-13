// Email service for authentication emails
import nodemailer from 'nodemailer';
import { logger } from '../utils/logger';

interface EmailOptions {
  to: string;
  subject: string;
  html: string;
  text?: string;
}

export class EmailService {
  private static transporter: nodemailer.Transporter;
  
  /**
   * Initialize the email service
   * In production, replace with a proper email service
   */
  static init(): void {
    // In development, use a test account
    if (process.env.NODE_ENV !== 'production') {
      this.setupDevTransport();
      return;
    }
    
    // In production, setup real email transport
    this.transporter = nodemailer.createTransport({
      host: process.env.EMAIL_HOST,
      port: parseInt(process.env.EMAIL_PORT || '587'),
      secure: process.env.EMAIL_SECURE === 'true',
      auth: {
        user: process.env.EMAIL_USER,
        pass: process.env.EMAIL_PASSWORD
      }
    });
    
    // Verify connection configuration
    this.transporter.verify()
      .then(() => {
        logger.info('Email service is ready to send messages');
      })
      .catch((error: Error) => {
        logger.error('Email service connection error:', error);
      });
  }
  
  /**
   * Setup development transport (logs emails instead of sending)
   */
  private static async setupDevTransport(): Promise<void> {
    try {
      // Generate test SMTP service account for development
      const testAccount = await nodemailer.createTestAccount();
      
      // Create reusable transporter using Ethereal SMTP service
      this.transporter = nodemailer.createTransport({
        host: 'smtp.ethereal.email',
        port: 587,
        secure: false,
        auth: {
          user: testAccount.user,
          pass: testAccount.pass
        }
      });
      
      logger.info('Development email service configured with Ethereal');
    } catch (error) {
      logger.error('Failed to setup development email transport:', error);
    }
  }
  
  /**
   * Send an email
   */
  static async sendEmail(options: EmailOptions): Promise<boolean> {
    try {
      const { to, subject, html, text } = options;
      
      const emailOptions = {
        from: process.env.EMAIL_FROM || 'noreply@miktos.com',
        to,
        subject,
        html,
        text: text || html.replace(/<[^>]*>/g, '') // Strip HTML tags for plain text
      };
      
      const info = await this.transporter.sendMail(emailOptions);
      
      // Log email preview URL in development
      if (process.env.NODE_ENV !== 'production') {
        // Get preview URL from info object directly
        const previewUrl = info.messageId ? 
          `https://ethereal.email/message/${info.messageId}` : 
          'Email sent but preview URL not available';
        logger.info(`Email preview URL: ${previewUrl}`);
      }
      
      logger.debug(`Email sent to ${to}: ${subject}`);
      return true;
    } catch (error) {
      logger.error('Error sending email:', error);
      return false;
    }
  }
  
  /**
   * Send verification email
   */
  static async sendVerificationEmail(
    to: string,
    name: string,
    token: string
  ): Promise<boolean> {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const verificationUrl = `${baseUrl}/verify-email?token=${token}`;
    
    const html = `
      <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
        <h2>Welcome to Miktos!</h2>
        <p>Hello ${name},</p>
        <p>Thank you for signing up! To complete your registration, please verify your email address by clicking the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${verificationUrl}" style="background-color: #4a6cf7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Verify Email Address</a>
        </div>
        <p>Alternatively, you can copy and paste the following link into your browser:</p>
        <p>${verificationUrl}</p>
        <p>This link will expire in 24 hours.</p>
        <p>If you did not create an account with us, please ignore this email.</p>
        <p>Best regards,<br>The Miktos Team</p>
      </div>
    `;
    
    return this.sendEmail({
      to,
      subject: 'Verify Your Email Address - Miktos',
      html
    });
  }
  
  /**
   * Send password reset email
   */
  static async sendPasswordResetEmail(
    to: string,
    name: string,
    token: string
  ): Promise<boolean> {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const resetUrl = `${baseUrl}/reset-password?token=${token}`;
    
    const html = `
      <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
        <h2>Reset Your Password</h2>
        <p>Hello ${name},</p>
        <p>We received a request to reset your password. If you didn't make this request, you can ignore this email.</p>
        <p>To reset your password, click the button below:</p>
        <div style="text-align: center; margin: 30px 0;">
          <a href="${resetUrl}" style="background-color: #4a6cf7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Reset Password</a>
        </div>
        <p>Alternatively, you can copy and paste the following link into your browser:</p>
        <p>${resetUrl}</p>
        <p>This link will expire in 1 hour.</p>
        <p>Best regards,<br>The Miktos Team</p>
      </div>
    `;
    
    return this.sendEmail({
      to,
      subject: 'Reset Your Password - Miktos',
      html
    });
  }
  
  /**
   * Send security alert email
   */
  static async sendSecurityAlertEmail(
    to: string,
    name: string,
    alertType: 'new-device' | 'unusual-location' | 'failed-attempts',
    details: Record<string, any>
  ): Promise<boolean> {
    const baseUrl = process.env.BASE_URL || 'http://localhost:3000';
    const securitySettingsUrl = `${baseUrl}/settings/security`;
    
    let alertTitle = '';
    let alertMessage = '';
    
    switch (alertType) {
      case 'new-device':
        alertTitle = 'New Device Login Detected';
        alertMessage = `
          <p>We detected a login to your account from a new device.</p>
          <p><strong>Device:</strong> ${details.browser} on ${details.os}</p>
          <p><strong>Location:</strong> ${details.city}, ${details.region}, ${details.country}</p>
          <p><strong>Time:</strong> ${new Date(details.timestamp).toLocaleString()}</p>
          <p>If this was you, no action is needed. If you don't recognize this activity, please secure your account immediately.</p>
        `;
        break;
        
      case 'unusual-location':
        alertTitle = 'Login from Unusual Location';
        alertMessage = `
          <p>We detected a login to your account from an unusual location.</p>
          <p><strong>Location:</strong> ${details.city}, ${details.region}, ${details.country}</p>
          <p><strong>Device:</strong> ${details.browser} on ${details.os}</p>
          <p><strong>Time:</strong> ${new Date(details.timestamp).toLocaleString()}</p>
          <p>If this was you, no action is needed. If you don't recognize this activity, please secure your account immediately.</p>
        `;
        break;
        
      case 'failed-attempts':
        alertTitle = 'Multiple Failed Login Attempts';
        alertMessage = `
          <p>There have been multiple failed login attempts to your account.</p>
          <p><strong>Number of attempts:</strong> ${details.attempts}</p>
          <p><strong>Last attempt from:</strong> ${details.location}</p>
          <p><strong>Time:</strong> ${new Date(details.timestamp).toLocaleString()}</p>
          <p>If these were your attempts, you can try resetting your password. If you don't recognize this activity, please secure your account immediately.</p>
        `;
        break;
    }
    
    const html = `
      <div style="max-width: 600px; margin: 0 auto; font-family: Arial, sans-serif;">
        <h2>Security Alert: ${alertTitle}</h2>
        <p>Hello ${name},</p>
        ${alertMessage}
        <div style="text-align: center; margin: 30px 0;">
          <a href="${securitySettingsUrl}" style="background-color: #4a6cf7; color: white; padding: 12px 24px; text-decoration: none; border-radius: 4px; display: inline-block;">Review Account Activity</a>
        </div>
        <p>If you didn't authorize this action, please:</p>
        <ol>
          <li>Change your password immediately</li>
          <li>Enable multi-factor authentication if not already enabled</li>
          <li>Review your recent account activity</li>
        </ol>
        <p>Best regards,<br>The Miktos Security Team</p>
      </div>
    `;
    
    return this.sendEmail({
      to,
      subject: `Security Alert: ${alertTitle} - Miktos`,
      html
    });
  }
}
