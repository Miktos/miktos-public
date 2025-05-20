#!/bin/zsh

# Initialize public Git repository
cd /Users/atorrella/Desktop/Miktos/Miktos_Public_Repo
git init

# Add all files
git add .

# Commit the initial set of files
git commit -m "Initial commit: Miktos public information repository"

# Instructions for next steps
echo "\n==== Next Steps (PUBLIC REPOSITORY) ===="
echo "1. Create a new PUBLIC GitHub repository at https://github.com/new"
echo "2. Run the following commands to push to GitHub:"
echo "   git remote add origin https://github.com/YOUR-USERNAME/miktos-public.git"
echo "   git branch -M main"
echo "   git push -u origin main"
echo "================="
