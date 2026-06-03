import 'dotenv/config';
import { sendPasswordResetEmail, sendWelcomeEmail } from './src/lib/email';

async function testEmails() {
  console.log('\n🔍 Testing email configuration...\n');
  
  // Check environment variables
  console.log('Environment variables:');
  console.log('RESEND_API_KEY:', process.env.RESEND_API_KEY ? '✅ Set' : '❌ Not set');
  console.log('EMAIL_FROM:', process.env.EMAIL_FROM || '❌ Not set');
  console.log('NODE_ENV:', process.env.NODE_ENV);
  console.log('');
  
  const testEmail = process.env.TEST_EMAIL || 'test@example.com';
  
  if (testEmail === 'test@example.com') {
    console.log('⚠️  Set TEST_EMAIL in your .env file to test with your actual email');
    console.log('');
  }
  
  // Test welcome email
  console.log('📧 Testing welcome email...');
  try {
    const result = await sendWelcomeEmail({
      to: testEmail,
      name: 'Test User'
    });
    console.log('Welcome email result:', result ? '✅ Success' : '❌ Failed');
  } catch (error: any) {
    console.error('❌ Welcome email error:', error?.message || error);
  }
  
  console.log('');
  
  // Test password reset email
  console.log('📧 Testing password reset email...');
  try {
    const result = await sendPasswordResetEmail({
      to: testEmail,
      resetUrl: 'http://localhost:3000/reset-password?token=test123'
    });
    console.log('Password reset email result:', result ? '✅ Success' : '❌ Failed');
  } catch (error: any) {
    console.error('❌ Password reset email error:', error?.message || error);
  }
  
  console.log('');
}

testEmails().catch(console.error);
